import { Finding, PlanNode, Snapshot } from './types';
export function findingsFor(s: Snapshot, slowMs: number, idleSeconds = 60): Finding[] {
  const f: Finding[] = [];
  const slow = s.queries.filter((q) => q.meanMs >= slowMs);
  if (slow.length)
    f.push({
      severity: 'warning',
      title: `${slow.length} expensive query pattern${slow.length === 1 ? '' : 's'}`,
      detail:
        s.queryMode === 'samples'
          ? `Execution samples exceed ${slowMs} ms. These are individual profiler or slow-log entries, not cumulative patterns.`
          : `Mean latency exceeds ${slowMs} ms. These are cumulative server statistics, not timings from this refresh.`,
      action:
        'Sort by total time to find the largest workload cost, then inspect a representative query plan.',
    });
  const blocked = s.sessions.filter((x) => x.blockers.length);
  if (blocked.length)
    f.push({
      severity: blocked.length >= 5 ? 'critical' : 'warning',
      confidence: 'high',
      section: 'sessions',
      evidence: `${blocked.length} blocked sessions at capture time; wait duration is not measured.`,
      title: `${blocked.length} blocked session${blocked.length === 1 ? '' : 's'}`,
      detail: 'Another session is holding a conflicting lock.',
      action:
        'Review the blocker IDs and transaction age with the owner. This extension never terminates sessions.',
    });
  const idle = s.sessions.filter(
    (x) => x.state === 'idle in transaction' && (x.idleSeconds ?? 0) > idleSeconds,
  );
  if (idle.length)
    f.push({
      severity: 'warning',
      title: 'Long idle transactions',
      detail: `${idle.length} transaction(s) have been idle for over ${idleSeconds} seconds.`,
      action:
        'Ensure application transactions commit or roll back promptly; investigate abandoned connections.',
    });
  const bloated = s.tables.filter(
    (t) => t.deadRows > 1000 && t.deadRows / Math.max(t.rows + t.deadRows, 1) > 0.2,
  );
  if (bloated.length)
    f.push({
      severity: 'warning',
      title: 'Dead tuple pressure',
      detail: bloated.map((t) => t.name).join(', '),
      action:
        'Review autovacuum configuration and long transactions. Dead tuple estimates do not measure physical bloat.',
    });
  const unused = s.indexes.filter((i) => i.scans === 0 && i.sizeBytes > 1048576);
  if (unused.length)
    f.push({
      severity: 'info',
      title: 'Indexes with no recorded reads',
      detail: `${unused.length} large index(es) have zero reads in the statistics window.`,
      action:
        'Check the statistics reset time, constraints, replicas and periodic workloads before considering removal.',
    });
  const scans = s.tables.filter(
    (t) => t.rows > 100000 && t.scans > 100 && t.indexScans < t.scans / 10,
  );
  if (scans.length)
    f.push({
      severity: 'info',
      title: 'Frequent sequential scans',
      detail: scans.map((t) => t.name).join(', '),
      action:
        'Inspect query selectivity and plans. Sequential scans can be optimal; do not add indexes based only on counters.',
    });
  const total = s.queries.reduce((sum, q) => sum + q.totalMs, 0);
  const costly = s.queries.filter(
    (q) => q.calls >= 100 && q.totalMs >= 1000 && q.totalMs >= total * 0.25,
  );
  if (s.queryMode !== 'samples' && costly.length)
    f.push({
      severity: 'info',
      title: 'Frequently repeated requests consume time',
      detail: `${costly.length} patterns each account for at least 25% of total time among the collected queries, with at least 100 calls.`,
      action:
        'Review repeated requests with your developer; batching or caching may help. Compare a representative interval first.',
      section: 'queries',
      confidence: 'medium',
      evidence:
        'Share of collected query time only; concurrent query times are not wall-clock utilization.',
    });
  for (const item of f) {
    item.section ??= /transaction|session/i.test(item.title)
      ? 'sessions'
      : /index/i.test(item.title)
        ? 'indexes'
        : /tuple|scan/i.test(item.title)
          ? 'tables'
          : 'queries';
    item.confidence ??= item.section === 'indexes' ? 'low' : 'medium';
    item.evidence ??=
      item.section === 'indexes'
        ? 'Observation window and constraint purpose must be checked; zero reads is not proof that an index is unnecessary.'
        : 'Based on available records at capture time; coverage may be incomplete.';
  }
  return f;
}
export function postgresPlan(raw: unknown): PlanNode[] {
  const list = Array.isArray(raw) ? raw : [raw];
  function node(v: any): PlanNode {
    return {
      name: String(v['Node Type'] ?? 'Plan'),
      rows: v['Plan Rows'],
      cost: v['Total Cost'],
      actualMs: v['Actual Total Time'],
      detail: [
        v['Relation Name'],
        v['Index Name'],
        v['Filter'] ? `Filter: ${v['Filter']}` : '',
        v['Actual Loops'] ? `Loops: ${v['Actual Loops']}` : '',
        v['Sort Space Type'] === 'Disk' ? `Disk sort: ${v['Sort Space Used']} KB` : '',
        v['Hash Batches'] > 1 ? `Hash batches: ${v['Hash Batches']}` : '',
      ]
        .filter(Boolean)
        .join(' · '),
      children: (v.Plans ?? []).map(node),
    };
  }
  return list.filter((v) => v?.Plan).map((v) => node(v.Plan));
}
export function genericPlan(raw: unknown): PlanNode[] {
  function walk(v: any, name: string): PlanNode {
    if (v === null || typeof v !== 'object') return { name, detail: String(v), children: [] };
    return {
      name,
      rows: Number.isFinite(Number(v.rows_examined_per_scan))
        ? Number(v.rows_examined_per_scan)
        : undefined,
      detail: [v.table_name, v.access_type, v.key].filter(Boolean).join(' · '),
      children: Object.entries(v)
        .filter(([k, x]) => x !== null && typeof x === 'object' && !['cost_info'].includes(k))
        .map(([k, x]) => walk(x, k)),
    };
  }
  return [walk(raw, 'Query plan')];
}
export function planFindings(nodes: PlanNode[]): Finding[] {
  const f: Finding[] = [];
  function visit(n: PlanNode) {
    if (n.name === 'Seq Scan' && (n.rows ?? 0) > 10000)
      f.push({
        severity: 'info',
        title: 'Large sequential scan',
        detail: `${n.detail ?? ''}: estimated ${n.rows} rows.`,
        action: 'Check selectivity and available indexes; a scan may still be the cheapest plan.',
      });
    if (/external|disk/i.test(n.detail ?? ''))
      f.push({
        severity: 'warning',
        title: 'Possible disk spill',
        detail: n.detail ?? '',
        action: 'Review sort/hash memory and row counts before changing memory settings.',
      });
    n.children.forEach(visit);
  }
  nodes.forEach(visit);
  return f;
}
export function compareSnapshots(before: Snapshot, after: Snapshot) {
  const elapsed = (Date.parse(after.timestamp) - Date.parse(before.timestamp)) / 1000;
  const incompatible =
    before.engine !== after.engine ||
    before.connection !== after.connection ||
    before.queryMode === 'samples' ||
    after.queryMode === 'samples';
  const reset =
    (before.serverIdentity !== undefined &&
      after.serverIdentity !== undefined &&
      before.serverIdentity !== after.serverIdentity) ||
    (before.queryStatsReset !== undefined &&
      after.queryStatsReset !== undefined &&
      before.queryStatsReset !== after.queryStatsReset) ||
    (after.uptimeSeconds !== undefined &&
      before.uptimeSeconds !== undefined &&
      after.uptimeSeconds < before.uptimeSeconds);
  return {
    elapsedSeconds: elapsed,
    reset,
    incompatible,
    queries: after.queries.map((q) => {
      const matches = before.queries.filter((x) => x.id === q.id);
      const old =
        matches.length === 1 && after.queries.filter((x) => x.id === q.id).length === 1
          ? matches[0]
          : undefined;
      const dc = old ? q.calls - old.calls : null;
      const dt = old ? q.totalMs - old.totalMs : null;
      const valid =
        !incompatible &&
        !reset &&
        !!old &&
        old.query === q.query &&
        [old.calls, old.totalMs, q.calls, q.totalMs].every((n) => Number.isFinite(n) && n >= 0) &&
        dc !== null &&
        dt !== null &&
        dc >= 0 &&
        dt >= 0 &&
        (dc > 0 || dt === 0) &&
        Number.isFinite(elapsed) &&
        elapsed > 0;
      return {
        id: q.id,
        query: q.query,
        callsDelta: valid ? dc : null,
        totalMsDelta: valid ? dt : null,
        intervalMeanMs: valid && dc! > 0 ? dt! / dc! : null,
        callsPerSecond: valid ? dc! / elapsed : null,
      };
    }),
  };
}

/** Prefer valid interval workload counters; never invent missing/reset deltas. */
export function recentFindings(
  before: Snapshot,
  after: Snapshot,
  slowMs: number,
  idleSeconds = 60,
): void {
  const comparison = compareSnapshots(before, after);
  if (comparison.incompatible || comparison.reset || comparison.elapsedSeconds <= 0) return;
  const valid = comparison.queries.filter(
    (q) => q.callsDelta !== null && q.callsDelta > 0 && q.intervalMeanMs !== null,
  );
  const matched = comparison.queries.filter((q) => q.callsDelta !== null);
  if (!matched.length) return;
  after.recentQueryCalls = valid.reduce((sum, q) => sum + q.callsDelta!, 0);
  const interval = {
    ...after,
    queries: valid.map((q) => ({
      id: q.id,
      query: q.query,
      calls: q.callsDelta!,
      totalMs: q.totalMsDelta!,
      meanMs: q.intervalMeanMs!,
      rows: 0,
    })),
  };
  after.findings = [
    ...after.findings.filter((f) => f.section !== 'queries'),
    ...findingsFor(interval, slowMs, idleSeconds)
      .filter((f) => f.section === 'queries')
      .map((f) => ({
        ...f,
        detail: f.detail.replace(
          'These are cumulative server statistics, not timings from this refresh.',
          'These are matched counter changes since the previous successful check.',
        ),
      })),
  ];
  after.observation = `Recent query findings cover ${valid.length} matched active patterns over ${Math.round(comparison.elapsedSeconds)} seconds. Missing, reset and inactive patterns are excluded. Other findings describe the current snapshot.`;
}

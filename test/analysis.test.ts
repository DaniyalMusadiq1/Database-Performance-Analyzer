import test from 'node:test';
import assert from 'node:assert/strict';
import { demoSnapshot } from '../src/demo';
import { compareSnapshots, postgresPlan, findingsFor } from '../src/analysis';
import { exportSnapshot } from '../src/reports';
import { inspectFiles } from '../src/discovery';
test('Findings explain blockers, idle transactions and dead tuples', () => {
  const s = demoSnapshot();
  const f = findingsFor(s, 100);
  assert.ok(f.some((x) => x.title.includes('blocked session') && x.severity === 'warning'));
  assert.ok(f.some((x) => x.title === 'Dead tuple pressure'));
  assert.ok(f.some((x) => x.title === 'Long idle transactions'));
});
test('Compares counters and refuses reset or unknown counters', () => {
  const a = demoSnapshot(),
    b = structuredClone(a);
  a.timestamp = '2026-10-09T00:00:00Z';
  b.timestamp = '2026-10-09T00:00:10Z';
  b.queries[0].calls += 10;
  b.queries[0].totalMs += 500;
  const diff = compareSnapshots(a, b);
  assert.equal(diff.queries[0].callsDelta, 10);
  assert.equal(diff.queries[0].intervalMeanMs, 50);
  b.queries[0].calls = 0;
  assert.equal(compareSnapshots(a, b).queries[0].callsDelta, null);
  b.uptimeSeconds = 0;
  assert.equal(compareSnapshots(a, b).reset, true);
});
test('Nested PostgreSQL plans preserve operator information', () => {
  const nodes = postgresPlan([
    {
      Plan: {
        'Node Type': 'Nested Loop',
        'Total Cost': 10,
        Plans: [{ 'Node Type': 'Index Scan', 'Relation Name': 'orders', 'Plan Rows': 1 }],
      },
    },
  ]);
  assert.equal(nodes[0].children[0].name, 'Index Scan');
  assert.equal(nodes[0].children[0].detail, 'orders');
});
test('Report privacy omits SQL, users and definitions', () => {
  const s = demoSnapshot();
  const json = exportSnapshot(s, 'json', false);
  assert.ok(!json.includes('SELECT customer_id'));
  assert.ok(!json.includes('checkout'));
  assert.ok(!json.includes('CREATE INDEX'));
  assert.ok(exportSnapshot(s, 'markdown', true).includes('Database Performance Report'));
  const malicious = structuredClone(s);
  malicious.queries[0].query = '=evil';
  assert.ok(exportSnapshot(malicious, 'csv', true).includes("'=evil"));
});
test('Discovery detects URLs and models without evaluating project code', () => {
  const result = inspectFiles([
    {
      path: '.env',
      text: 'DATABASE_URL="postgresql://user:pw@localhost/app"\nREDIS_URL=redis://localhost:6379',
    },
    {
      path: 'schema.prisma',
      text: 'model Customer {\n id Int @id\n}\ndatasource db { provider = "postgresql" }',
    },
    { path: 'package.json', text: '{"dependencies":{"@prisma/client":"6","mongoose":"8"}}' },
    { path: 'models.py', text: 'class Invoice(models.Model):\n pass' },
  ]);
  assert.equal(result.connections.length, 2);
  assert.equal(result.connections[0].target, 'localhost/app');
  assert.ok(result.models.some((m) => m.name === 'Customer'));
  assert.ok(result.models.some((m) => m.name === 'Invoice'));
  assert.ok(result.frameworks.includes('Prisma'));
});

test('Comparisons reject changed query reset timestamps and individual samples', () => {
  const a = demoSnapshot(),
    b = structuredClone(a);
  a.timestamp = '2026-10-09T00:00:00Z';
  b.timestamp = '2026-10-09T00:00:10Z';
  a.queryStatsReset = '2026-10-08T00:00:00Z';
  b.queryStatsReset = '2026-10-09T00:00:01Z';
  b.queries[0].calls += 100;
  assert.equal(compareSnapshots(a, b).reset, true);
  assert.equal(compareSnapshots(a, b).queries[0].callsDelta, null);
  b.queryStatsReset = a.queryStatsReset;
  b.queryMode = 'samples';
  assert.equal(compareSnapshots(a, b).incompatible, true);
  assert.equal(compareSnapshots(a, b).queries[0].callsDelta, null);
});
test('Profiler findings describe samples instead of cumulative patterns', () => {
  const s = demoSnapshot();
  s.queryMode = 'samples';
  assert.ok(findingsFor(s, 100)[0].detail.includes('individual profiler'));
});

test('Server identity changes detect restarts even when uptime has already surpassed the baseline', () => {
  const a = demoSnapshot(),
    b = structuredClone(a);
  a.serverIdentity = 'boot-a';
  b.serverIdentity = 'boot-b';
  a.uptimeSeconds = 1;
  b.uptimeSeconds = 100;
  assert.equal(compareSnapshots(a, b).reset, true);
});

test('Idle transaction findings use idle duration, not transaction age', () => {
  const s = demoSnapshot();
  const idle = s.sessions.find((x) => x.state === 'idle in transaction')!;
  idle.ageSeconds = 10000;
  idle.idleSeconds = 2;
  assert.ok(!findingsFor(s, 100).some((f) => f.title === 'Long idle transactions'));
  idle.idleSeconds = 90;
  assert.ok(findingsFor(s, 100, 60).some((f) => f.title === 'Long idle transactions'));
  assert.ok(!findingsFor(s, 100, 120).some((f) => f.title === 'Long idle transactions'));
});
test('Ambiguous query identities never produce interval comparisons', () => {
  const a = demoSnapshot(),
    b = structuredClone(a);
  a.timestamp = '2026-10-09T00:00:00Z';
  b.timestamp = '2026-10-09T00:00:10Z';
  b.queries.push({ ...b.queries[0] });
  assert.equal(compareSnapshots(a, b).queries[0].callsDelta, null);
});
test('Recent findings use valid interval activity instead of historic mean latency', async () => {
  const { recentFindings } = await import('../src/analysis.js');
  const a = demoSnapshot(),
    b = structuredClone(a);
  a.timestamp = '2026-10-09T00:00:00Z';
  b.timestamp = '2026-10-09T00:00:10Z';
  b.queries[0].calls += 10;
  b.queries[0].totalMs += 10;
  recentFindings(a, b, 100);
  assert.ok(b.observation?.includes('1 matched active patterns'));
  assert.ok(!b.findings.some((f) => f.title.includes('expensive query')));
  assert.ok(b.findings.some((f) => f.section === 'sessions'));
});

test('Quiet intervals clear historical query warnings without removing session findings', async () => {
  const { recentFindings } = await import('../src/analysis.js');
  const a = demoSnapshot(),
    b = structuredClone(a);
  a.timestamp = '2026-10-09T00:00:00Z';
  b.timestamp = '2026-10-09T00:00:10Z';
  recentFindings(a, b, 100);
  assert.ok(b.observation?.includes('0 matched active patterns'));
  assert.ok(!b.findings.some((f) => f.section === 'queries'));
  assert.ok(b.findings.some((f) => f.section === 'sessions'));
});
test('Comparisons reject invalid counters, reused IDs and time changes without calls', () => {
  const a = demoSnapshot();
  a.timestamp = '2026-10-09T00:00:00Z';
  for (const change of [
    (q: (typeof a.queries)[number]) => {
      q.calls = Infinity;
    },
    (q: (typeof a.queries)[number]) => {
      q.totalMs = NaN;
    },
    (q: (typeof a.queries)[number]) => {
      q.query = 'SELECT changed';
    },
    (q: (typeof a.queries)[number]) => {
      q.totalMs += 10;
    },
  ]) {
    const b = structuredClone(a);
    b.timestamp = '2026-10-09T00:00:10Z';
    change(b.queries[0]);
    assert.equal(compareSnapshots(a, b).queries[0].callsDelta, null);
  }
});

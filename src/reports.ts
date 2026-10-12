import { Snapshot } from './types';
import { csvCell } from './security';
export function exportSnapshot(
  snapshot: Snapshot,
  format: 'json' | 'markdown' | 'csv',
  includeSql: boolean,
): string {
  const s: Snapshot = JSON.parse(JSON.stringify(snapshot));
  if (!includeSql) {
    s.queries = s.queries.map((q) => ({ ...q, query: '[omitted]' }));
    s.sessions = s.sessions.map((q) => ({ ...q, query: '[omitted]', user: '[omitted]' }));
    s.indexes = s.indexes.map((i) => ({ ...i, definition: '[omitted]' }));
    s.tables = s.tables.map((t) => ({ ...t, extra: undefined }));
  }
  if (format === 'json') return JSON.stringify(s, null, 2);
  if (format === 'csv')
    return [
      ['Pattern ID', 'Query', 'Calls', 'Total ms', 'Mean ms', 'Rows'].map(csvCell).join(','),
      ...s.queries.map((q) =>
        [q.id, q.query, q.calls, q.totalMs, q.meanMs, q.rows].map(csvCell).join(','),
      ),
    ].join('\r\n');
  const md = (v: unknown) =>
    String(v ?? '')
      .replace(/[\\`*_{}\[\]<>#|]/g, '\\$&')
      .replace(/[\r\n]+/g, ' ');
  return [
    `# Database Performance Report`,
    ``,
    `Connection: ${md(s.connection)} · ${s.engine}`,
    `Captured: ${s.timestamp}`,
    ``,
    `Scope: ${md(s.observation || 'Historical counters or individual samples; see metric descriptions.')}`,
    `This report is advisory. Missing diagnostics do not mean the database is healthy.`,
    ``,
    `## Diagnostic readiness`,
    ``,
    ...(s.availability || []).map((a) => `- ${md(a.label)}: ${md(a.state)} — ${md(a.action)}`),
    ``,
    `## Metrics`,
    ``,
    ...s.metrics.map(
      (m) => `- **${md(m.label)}**: ${md(m.value)} ${md(m.unit ?? '')} — ${md(m.description)}`,
    ),
    ``,
    `## Findings`,
    ``,
    ...(s.findings.length
      ? s.findings.map(
          (f) =>
            `- **${f.severity.toUpperCase()}: ${md(f.title)}** — ${md(f.detail)} ${md(f.action)}${f.confidence ? ` Confidence: ${f.confidence}. ${md(f.evidence)}` : ''}`,
        )
      : ['No advisory findings in the available statistics.']),
    ``,
    `## Query patterns`,
    ``,
    `| Pattern | Calls | Total ms | Mean ms | Query |`,
    `| --- | ---: | ---: | ---: | --- |`,
    ...s.queries.map(
      (q) =>
        `| ${md(q.id)} | ${q.calls} | ${q.totalMs.toFixed(2)} | ${q.meanMs.toFixed(2)} | ${md(q.query)} |`,
    ),
    ``,
    `## Collection notices`,
    ``,
    ...s.notices.map((x) => `- ${md(x)}`),
    ``,
    `Counters may be cumulative, estimated, or scoped to the server. Review metric descriptions and collection notices. Recommendations are advisory; no database changes were performed.`,
    ` `,
  ].join('\n');
}

/** Static handoff text deliberately excludes connection targets and credentials. */
export function administratorRequest(engine?: Snapshot['engine']): string {
  const checks: Partial<Record<Snapshot['engine'], string>> = {
    postgres:
      'Please review pg_monitor/pg_read_all_stats access and pg_stat_statements availability. A DBA must install/configure query statistics if needed.',
    mysql:
      'Please review read access to Performance Schema statement digests and metadata, and PROCESS only if broader session visibility is required.',
    sqlserver:
      'Please review metadata visibility, the monitoring STATE/PERFORMANCE STATE permissions appropriate to this server version, and SHOWPLAN if query plans are required.',
    mongodb:
      'Please review database metadata access, existing system.profile samples and serverStatus privileges. The app does not enable profiling.',
    redis:
      'Please provide a dedicated ACL account allowed to run INFO and SLOWLOG GET. The app does not scan keys or change settings.',
    sqlite:
      'Please provide a consistent SQLite backup file. Active WAL/journal files cannot be inspected directly.',
  };
  return [
    'I would like to use Database Performance Analyzer for read-only diagnostics.',
    'Please provide the database type, server address, port, database name and a dedicated monitoring account through our approved secure channel.',
    'Please confirm network/VPN access and certificate requirements. Connections originate from the VS Code workspace host, including SSH/container workspaces.',
    checks[engine || 'demo'] ||
      'Please confirm access to query statistics, sessions and database metadata for this database type.',
    'Do not send passwords in ordinary email or chat. Please review permissions before granting access; the app does not configure the database server.',
  ].join('\n\n');
}

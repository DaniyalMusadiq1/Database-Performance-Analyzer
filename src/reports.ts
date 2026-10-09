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
            `- **${f.severity.toUpperCase()}: ${md(f.title)}** — ${md(f.detail)} ${md(f.action)}`,
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

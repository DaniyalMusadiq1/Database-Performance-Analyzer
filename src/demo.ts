import { Snapshot } from './types';
import { findingsFor } from './analysis';
export function demoSnapshot(slowMs = 100): Snapshot {
  const tick = Math.floor(Date.now() / 1000);
  const s: Snapshot = {
    engine: 'demo',
    connection: 'Demo · Commerce / PostgreSQL',
    timestamp: new Date().toISOString(),
    uptimeSeconds: tick - 1700000000,
    metrics: [
      {
        label: 'Active sessions',
        value: 12,
        description: 'Synthetic sample; no database connection.',
      },
      {
        label: 'Cache hit ratio',
        value: 98.7,
        unit: '%',
        description: 'Blocks served from PostgreSQL shared buffers.',
      },
      { label: 'Database size', value: 4.8, unit: 'GB', description: 'Synthetic database size.' },
      {
        label: 'Transactions',
        value: 1520340 + tick,
        description: 'Cumulative commits and rollbacks.',
      },
    ],
    queries: [
      {
        id: 'q1',
        query:
          'SELECT customer_id, SUM(total) FROM orders WHERE created_at > $1 GROUP BY customer_id',
        calls: 1800 + tick,
        totalMs: 540000 + tick * 100,
        meanMs: 300,
        rows: 80000,
      },
      {
        id: 'q2',
        query: 'SELECT * FROM products WHERE category_id = $1 ORDER BY price',
        calls: 9400 + tick,
        totalMs: 310200 + tick * 10,
        meanMs: 33,
        rows: 230000,
      },
      {
        id: 'q3',
        query: 'UPDATE inventory SET quantity = quantity - $1 WHERE product_id = $2',
        calls: 21000 + tick,
        totalMs: 42000 + tick,
        meanMs: 2,
        rows: 21000,
      },
    ],
    sessions: [
      {
        id: '218',
        user: 'checkout',
        state: 'active',
        ageSeconds: 34,
        wait: 'Lock / transactionid',
        query: 'UPDATE inventory SET quantity = quantity - 1 WHERE product_id = 42',
        blockers: ['201'],
      },
      {
        id: '201',
        user: 'worker',
        state: 'idle in transaction',
        idleSeconds: 120,
        ageSeconds: 145,
        wait: 'Client / ClientRead',
        query: 'UPDATE inventory SET quantity = 10 WHERE product_id = 42',
        blockers: [],
      },
    ],
    tables: [
      {
        name: 'public.orders',
        rows: 1450000,
        sizeBytes: 1870000000,
        scans: 1200,
        indexScans: 500,
        deadRows: 460000,
      },
      {
        name: 'public.products',
        rows: 84000,
        sizeBytes: 58000000,
        scans: 120,
        indexScans: 9300,
        deadRows: 240,
      },
      {
        name: 'public.inventory',
        rows: 84000,
        sizeBytes: 16000000,
        scans: 12,
        indexScans: 24000,
        deadRows: 1200,
      },
    ],
    indexes: [
      {
        name: 'orders_customer_idx',
        table: 'public.orders',
        scans: 500,
        sizeBytes: 64000000,
        definition: 'CREATE INDEX orders_customer_idx ON orders (customer_id)',
      },
      {
        name: 'orders_legacy_idx',
        table: 'public.orders',
        scans: 0,
        sizeBytes: 48000000,
        definition: 'CREATE INDEX orders_legacy_idx ON orders (legacy_reference)',
      },
    ],
    findings: [],
    capabilities: ['queries', 'sessions', 'tables', 'indexes', 'explain'],
    notices: ['Demo mode: all metrics and query data are synthetic.'],
  };
  s.findings = findingsFor(s, slowMs);
  return s;
}

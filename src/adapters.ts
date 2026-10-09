import { Client } from 'pg';
import mysql, { Connection as MyConnection } from 'mysql2/promise';
import mssql from 'mssql';
import { MongoClient } from 'mongodb';
import { createClient } from 'redis';
import { sqliteQueries } from './sqlite';
import { deadline, throwIfAborted, isInterrupted, acquireResource } from './lifecycle';
import { Profile, Snapshot, Options, Plan } from './types';
import { findingsFor, genericPlan, postgresPlan, planFindings } from './analysis';
import { redactError, validateSql, redisTransportUri, networkHostname } from './security';
import { demoSnapshot } from './demo';
type Row = Record<string, any>;
const n = (v: unknown) => Number(v) || 0;
function base(p: Profile): Snapshot {
  return {
    engine: p.engine,
    connection: p.name,
    timestamp: new Date().toISOString(),
    metrics: [],
    queries: [],
    sessions: [],
    tables: [],
    indexes: [],
    findings: [],
    capabilities: [],
    notices: [],
    queryMode: ['mongodb', 'redis'].includes(p.engine) ? 'samples' : 'cumulative',
  };
}
async function optional(s: Snapshot, label: string, uri: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (e) {
    if (isInterrupted(e)) throw e;
    s.notices.push(`${label} unavailable: ${redactError(e, uri)}`);
  }
}
async function pgSession<T>(
  uri: string,
  p: Profile,
  o: Options,
  work: (c: Client) => Promise<T>,
): Promise<T> {
  const connectionUrl = new URL(uri);
  for (const key of [
    'host',
    'port',
    'user',
    'password',
    'database',
    'sslmode',
    'sslcert',
    'sslkey',
    'sslrootcert',
    'ssl',
    'options',
    'statement_timeout',
    'query_timeout',
    'application_name',
  ])
    connectionUrl.searchParams.delete(key);
  const c = new Client({
    connectionString: connectionUrl.toString(),
    ssl: p.tls ? { rejectUnauthorized: true } : false,
    connectionTimeoutMillis: o.timeoutMs,
    statement_timeout: o.timeoutMs,
    query_timeout: o.timeoutMs,
    application_name: 'vscode-database-performance-analyzer',
    options: `-c default_transaction_read_only=on -c lock_timeout=${Math.min(o.timeoutMs, 3000)}`,
  });
  c.on('error', () => {});
  try {
    return await deadline(
      { ...o, timeoutMs: o.timeoutMs * 8 },
      async (signal) => {
        await c.connect();
        throwIfAborted(signal);
        return await work(c);
      },
      () => {
        void c.end().catch(() => {});
      },
    );
  } finally {
    await c.end().catch(() => {});
  }
}
async function mySession<T>(
  uri: string,
  p: Profile,
  o: Options,
  work: (q: (sql: string) => Promise<Row[]>) => Promise<T>,
): Promise<T> {
  let c: MyConnection | undefined;
  try {
    return await deadline(
      { ...o, timeoutMs: o.timeoutMs * 8 },
      async (signal) => {
        const u = new URL(uri);
        c = await acquireResource(
          signal,
          () =>
            mysql.createConnection({
              host: networkHostname(uri),
              port: Number(u.port) || 3306,
              user: decodeURIComponent(u.username),
              password: decodeURIComponent(u.password),
              database: decodeURIComponent(u.pathname.slice(1)),
              ssl: p.tls ? { rejectUnauthorized: true } : undefined,
              connectTimeout: o.timeoutMs,
              multipleStatements: false,
              supportBigNumbers: true,
              bigNumberStrings: true,
            }),
          (conn) => conn.destroy(),
        );
        const conn = c;
        const q = async (sql: string) =>
          deadline(
            { ...o, signal },
            async () => {
              const [rows] = await conn.query({ sql, timeout: o.timeoutMs });
              return rows as Row[];
            },
            () => conn.destroy(),
          );
        await q('SET SESSION TRANSACTION READ ONLY');
        return await work(q);
      },
      () => c?.destroy(),
    );
  } finally {
    if (c) c.destroy();
  }
}
async function msSession<T>(
  uri: string,
  p: Profile,
  o: Options,
  work: (q: (sql: string) => Promise<Row[]>) => Promise<T>,
): Promise<T> {
  const u = new URL(uri);
  const pool = new mssql.ConnectionPool({
    server: networkHostname(uri),
    port: Number(u.port) || 1433,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.slice(1)) || 'master',
    connectionTimeout: o.timeoutMs,
    requestTimeout: o.timeoutMs,
    pool: { max: 1, min: 0, idleTimeoutMillis: 1000 },
    options: {
      encrypt: p.tls,
      trustServerCertificate: false,
      appName: 'Database Performance Analyzer',
    },
  });
  pool.on('error', () => {});
  try {
    return await deadline(
      { ...o, timeoutMs: o.timeoutMs * 8 },
      async (signal) => {
        await acquireResource(
          signal,
          () => pool.connect(),
          () => pool.close(),
        );
        return work(async (sql) => {
          const request = pool.request();
          return deadline(
            { ...o, signal },
            async () => (await request.query(sql)).recordset as Row[],
            () => request.cancel(),
          );
        });
      },
      () => {
        void pool.close().catch(() => {});
      },
    );
  } finally {
    await pool.close().catch(() => {});
  }
}
export async function collect(p: Profile, uri: string, o: Options): Promise<Snapshot> {
  throwIfAborted(o.signal);
  if (p.engine === 'demo') return demoSnapshot(o.slowQueryMs);
  const s = base(p);
  if (p.engine === 'postgres')
    await pgSession(uri, p, o, async (c) => {
      const q = async (sql: string) => (await c.query(sql)).rows as Row[];
      const [v] = await q(
        `SELECT pg_database_size(current_database()) AS bytes, numbackends, xact_commit, xact_rollback, blks_hit, blks_read, deadlocks, stats_reset, pg_postmaster_start_time() AS started, EXTRACT(EPOCH FROM now()-pg_postmaster_start_time()) AS uptime FROM pg_stat_database WHERE datname=current_database()`,
      );
      s.uptimeSeconds = n(v.uptime);
      s.serverIdentity = new Date(v.started).toISOString();
      s.metrics = [
        {
          label: 'Connections',
          value: n(v.numbackends),
          description: 'Backends connected to this database.',
        },
        {
          label: 'Cache hit ratio',
          value:
            Math.round((n(v.blks_hit) / Math.max(1, n(v.blks_hit) + n(v.blks_read))) * 10000) / 100,
          unit: '%',
          description: 'PostgreSQL shared buffer hits; does not include OS cache.',
        },
        {
          label: 'Database size',
          value: n(v.bytes),
          unit: 'bytes',
          description: 'Total on-disk size.',
        },
        {
          label: 'Transactions',
          value: n(v.xact_commit) + n(v.xact_rollback),
          description: 'Cumulative transactions since statistics reset.',
        },
        {
          label: 'Deadlocks',
          value: n(v.deadlocks),
          description: 'Cumulative detected deadlocks.',
        },
      ];
      s.notices.push(`Statistics reset: ${v.stats_reset ?? 'unknown'}.`);
      await optional(s, 'Sessions', uri, async () => {
        s.sessions = (
          await q(
            `SELECT pid, usename, state, EXTRACT(EPOCH FROM now()-COALESCE(xact_start,query_start,backend_start)) AS age, wait_event_type, wait_event, LEFT(query,4000) AS query, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() ORDER BY xact_start NULLS LAST LIMIT 100`,
          )
        ).map((r) => ({
          id: String(r.pid),
          user: r.usename ?? '',
          state: r.state ?? 'restricted',
          ageSeconds: n(r.age),
          wait: [r.wait_event_type, r.wait_event].filter(Boolean).join(' / '),
          query: r.query ?? '',
          blockers: (r.blockers ?? []).map(String),
        }));
        s.capabilities.push('sessions');
      });
      await optional(s, 'Query statistics (requires pg_stat_statements)', uri, async () => {
        const extension = await q(
          `SELECT n.nspname,e.extversion FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pg_stat_statements'`,
        );
        if (!extension.length)
          throw new Error(
            'Enable pg_stat_statements with your DBA. No extension or settings are changed automatically.',
          );
        const schema = '"' + String(extension[0].nspname).replace(/"/g, '""') + '"';
        s.queries = (
          await q(
            `SELECT queryid::text AS id, LEFT(query,4000) AS query, calls, total_exec_time AS total, mean_exec_time AS mean, rows FROM ${schema}.pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) ORDER BY total_exec_time DESC LIMIT 50`,
          )
        ).map((r) => ({
          id: r.id,
          query: r.query,
          calls: n(r.calls),
          totalMs: n(r.total),
          meanMs: n(r.mean),
          rows: n(r.rows),
        }));
        s.capabilities.push('queries');
        if (
          Number(String(extension[0].extversion).split('.')[0]) > 1 ||
          Number(String(extension[0].extversion).split('.')[1]) >= 9
        ) {
          await optional(s, 'Query statistics reset timestamp', uri, async () => {
            const [info] = await q(`SELECT stats_reset FROM ${schema}.pg_stat_statements_info`);
            if (info?.stats_reset) s.queryStatsReset = new Date(info.stats_reset).toISOString();
          });
        }
      });
      await optional(s, 'Table health', uri, async () => {
        s.tables = (
          await q(
            `SELECT schemaname||'.'||relname AS name,n_live_tup,n_dead_tup,seq_scan,idx_scan,pg_total_relation_size(relid) AS bytes FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 100`,
          )
        ).map((r) => ({
          name: r.name,
          rows: n(r.n_live_tup),
          sizeBytes: n(r.bytes),
          scans: n(r.seq_scan),
          indexScans: n(r.idx_scan),
          deadRows: n(r.n_dead_tup),
        }));
        s.capabilities.push('tables');
      });
      await optional(s, 'Indexes', uri, async () => {
        s.indexes = (
          await q(
            `SELECT schemaname||'.'||indexrelname AS name,schemaname||'.'||relname AS table_name,idx_scan,pg_relation_size(indexrelid) AS bytes,pg_get_indexdef(indexrelid) AS definition FROM pg_stat_user_indexes ORDER BY pg_relation_size(indexrelid) DESC LIMIT 100`,
          )
        ).map((r) => ({
          name: r.name,
          table: r.table_name,
          scans: n(r.idx_scan),
          sizeBytes: n(r.bytes),
          definition: r.definition,
        }));
        s.capabilities.push('indexes');
      });
      s.capabilities.push('explain');
    });
  else if (p.engine === 'mysql')
    await mySession(uri, p, o, async (q) => {
      const rows = await q(
        "SHOW GLOBAL STATUS WHERE Variable_name IN ('Threads_connected','Threads_running','Questions','Uptime','Innodb_buffer_pool_read_requests','Innodb_buffer_pool_reads')",
      );
      const st = Object.fromEntries(rows.map((r) => [r.Variable_name, n(r.Value)]));
      s.uptimeSeconds = st.Uptime;
      s.metrics = [
        {
          label: 'Connections',
          value: st.Threads_connected ?? 0,
          description: 'Server-wide connected clients.',
        },
        {
          label: 'Running threads',
          value: st.Threads_running ?? 0,
          description: 'Server-wide non-sleeping threads.',
        },
        {
          label: 'Cache hit ratio',
          value:
            Math.round(
              (1 -
                (st.Innodb_buffer_pool_reads ?? 0) /
                  Math.max(st.Innodb_buffer_pool_read_requests ?? 1, 1)) *
                10000,
            ) / 100,
          unit: '%',
          description: 'InnoDB buffer-pool read hit ratio.',
        },
        {
          label: 'Statements',
          value: st.Questions ?? 0,
          description: 'Server-wide cumulative statements.',
        },
      ];
      await optional(s, 'Query statistics', uri, async () => {
        s.queries = (
          await q(
            `SELECT DIGEST AS id,LEFT(DIGEST_TEXT,4000) AS query,COUNT_STAR AS calls,SUM_TIMER_WAIT/1000000000 AS total,AVG_TIMER_WAIT/1000000000 AS mean,SUM_ROWS_SENT AS rows_sent FROM performance_schema.events_statements_summary_by_digest WHERE SCHEMA_NAME=DATABASE() AND DIGEST IS NOT NULL ORDER BY SUM_TIMER_WAIT DESC LIMIT 50`,
          )
        ).map((r) => ({
          id: r.id,
          query: r.query,
          calls: n(r.calls),
          totalMs: n(r.total),
          meanMs: n(r.mean),
          rows: n(r.rows_sent),
        }));
        s.capabilities.push('queries');
      });
      await optional(s, 'Sessions', uri, async () => {
        s.sessions = (
          await q(
            `SELECT ID,USER,COMMAND,TIME,STATE,LEFT(INFO,4000) AS INFO FROM information_schema.PROCESSLIST WHERE ID<>CONNECTION_ID() AND DB=DATABASE() ORDER BY TIME DESC LIMIT 100`,
          )
        ).map((r) => ({
          id: String(r.ID),
          user: r.USER,
          state: r.COMMAND,
          ageSeconds: n(r.TIME),
          wait: r.STATE ?? '',
          query: r.INFO ?? '',
          blockers: [],
        }));
        s.capabilities.push('sessions');
      });
      await optional(s, 'Tables', uri, async () => {
        s.tables = (
          await q(
            `SELECT TABLE_NAME,TABLE_ROWS,DATA_LENGTH,INDEX_LENGTH,DATA_FREE,ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() ORDER BY DATA_LENGTH+INDEX_LENGTH DESC LIMIT 100`,
          )
        ).map((r) => ({
          name: r.TABLE_NAME,
          rows: n(r.TABLE_ROWS),
          sizeBytes: n(r.DATA_LENGTH) + n(r.INDEX_LENGTH),
          scans: 0,
          indexScans: 0,
          deadRows: 0,
          extra: `${r.ENGINE}; allocated free bytes: ${n(r.DATA_FREE)}; row counts are estimates`,
        }));
        s.capabilities.push('tables');
      });
      await optional(s, 'Indexes', uri, async () => {
        s.indexes = (
          await q(
            `SELECT TABLE_NAME,INDEX_NAME,GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() GROUP BY TABLE_NAME,INDEX_NAME LIMIT 100`,
          )
        ).map((r) => ({
          name: r.INDEX_NAME,
          table: r.TABLE_NAME,
          scans: 0,
          sizeBytes: 0,
          definition: r.cols,
        }));
        s.capabilities.push('indexes');
      });
      s.capabilities.push('explain');
      s.notices.push(
        'MySQL index usage and table scan counters are unavailable in this view. Zero means not collected.',
      );
    });
  else if (p.engine === 'sqlserver')
    await msSession(uri, p, o, async (q) => {
      const [v] = await q(
        `SELECT DB_NAME() AS db, SUM(CAST(size AS bigint))*8192 AS bytes FROM sys.database_files`,
      );
      s.metrics = [
        {
          label: 'Database size',
          value: n(v.bytes),
          unit: 'bytes',
          description: 'Allocated database files.',
        },
      ];
      await optional(s, 'Query statistics', uri, async () => {
        s.queries = (
          await q(
            `SELECT TOP 50 CONVERT(varchar(130),qs.sql_handle,1)+':'+CAST(qs.statement_start_offset AS varchar) AS id,SUBSTRING(st.text,(qs.statement_start_offset/2)+1,((CASE qs.statement_end_offset WHEN -1 THEN DATALENGTH(st.text) ELSE qs.statement_end_offset END-qs.statement_start_offset)/2)+1) AS query,qs.execution_count AS calls,qs.total_elapsed_time/1000.0 AS total,qs.total_elapsed_time/1000.0/NULLIF(qs.execution_count,0) AS mean,qs.total_rows AS rows FROM sys.dm_exec_query_stats qs CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st WHERE st.dbid=DB_ID() ORDER BY qs.total_elapsed_time DESC`,
          )
        ).map((r) => ({
          id: r.id,
          query: r.query,
          calls: n(r.calls),
          totalMs: n(r.total),
          meanMs: n(r.mean),
          rows: n(r.rows),
        }));
        s.capabilities.push('queries');
      });
      await optional(s, 'Sessions', uri, async () => {
        s.sessions = (
          await q(
            `SELECT TOP 100 r.session_id,s.login_name,r.status,r.total_elapsed_time/1000.0 AS age,r.wait_type,r.blocking_session_id,LEFT(t.text,4000) AS query FROM sys.dm_exec_requests r JOIN sys.dm_exec_sessions s ON s.session_id=r.session_id CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) t WHERE r.database_id=DB_ID() AND r.session_id<>@@SPID ORDER BY r.total_elapsed_time DESC`,
          )
        ).map((r) => ({
          id: String(r.session_id),
          user: r.login_name,
          state: r.status,
          ageSeconds: n(r.age),
          wait: r.wait_type ?? '',
          query: r.query ?? '',
          blockers: n(r.blocking_session_id) > 0 ? [String(r.blocking_session_id)] : [],
        }));
        s.capabilities.push('sessions');
      });
      await optional(s, 'Tables', uri, async () => {
        s.tables = (
          await q(
            `SELECT TOP 100 SCHEMA_NAME(t.schema_id)+'.'+t.name AS name,SUM(CASE WHEN p.index_id IN (0,1) THEN p.row_count ELSE 0 END) AS rows,SUM(p.reserved_page_count)*8192 AS bytes FROM sys.tables t JOIN sys.dm_db_partition_stats p ON p.object_id=t.object_id GROUP BY t.schema_id,t.name ORDER BY bytes DESC`,
          )
        ).map((r) => ({
          name: r.name,
          rows: n(r.rows),
          sizeBytes: n(r.bytes),
          scans: 0,
          indexScans: 0,
          deadRows: 0,
        }));
        s.capabilities.push('tables');
      });
      await optional(s, 'Indexes', uri, async () => {
        s.indexes = (
          await q(
            `SELECT TOP 100 i.name,SCHEMA_NAME(t.schema_id)+'.'+t.name AS table_name,COALESCE(u.user_seeks,0)+COALESCE(u.user_scans,0)+COALESCE(u.user_lookups,0) AS scans,i.type_desc FROM sys.indexes i JOIN sys.tables t ON t.object_id=i.object_id LEFT JOIN sys.dm_db_index_usage_stats u ON u.object_id=i.object_id AND u.index_id=i.index_id AND u.database_id=DB_ID() WHERE i.name IS NOT NULL ORDER BY scans DESC`,
          )
        ).map((r) => ({
          name: r.name,
          table: r.table_name,
          scans: n(r.scans),
          sizeBytes: 0,
          definition: r.type_desc,
        }));
        s.capabilities.push('indexes');
      });
      s.capabilities.push('explain');
    });
  else if (p.engine === 'sqlite') {
    const [pageRows, countRows, freeRows, versionRows, tableRows, indexRows] = await sqliteQueries(
      uri,
      o,
      [
        'PRAGMA page_size',
        'PRAGMA page_count',
        'PRAGMA freelist_count',
        'SELECT sqlite_version() AS v',
        "SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 100",
        "SELECT name,tbl_name,sql FROM sqlite_master WHERE type='index' LIMIT 100",
      ],
    );
    const page = n(pageRows[0]?.page_size),
      count = n(countRows[0]?.page_count),
      free = n(freeRows[0]?.freelist_count);
    s.metrics = [
      {
        label: 'Database size',
        value: page * count,
        unit: 'bytes',
        description: 'File page count multiplied by page size.',
      },
      { label: 'Free pages', value: free, description: 'Reusable pages on the freelist.' },
      {
        label: 'SQLite version',
        value: String(versionRows[0].v),
        description: 'Embedded inspection engine version.',
      },
    ];
    s.tables = tableRows.map((r) => ({
      name: r.name,
      rows: 0,
      sizeBytes: 0,
      scans: 0,
      indexScans: 0,
      deadRows: 0,
      extra: r.sql,
    }));
    s.indexes = indexRows.map((r) => ({
      name: r.name,
      table: r.tbl_name,
      scans: 0,
      sizeBytes: 0,
      definition: r.sql ?? 'Automatic constraint index',
    }));
    s.capabilities.push('tables', 'indexes', 'explain');
    s.notices.push(
      'Read-only in-memory copy. Table row counts, usage counters and live sessions are not collected. Active WAL files are rejected; inspect a consistent backup.',
    );
  } else if (p.engine === 'mongodb') {
    const c = new MongoClient(uri, {
      serverSelectionTimeoutMS: o.timeoutMs,
      connectTimeoutMS: o.timeoutMs,
      socketTimeoutMS: o.timeoutMs,
      maxPoolSize: 1,
      tls: p.tls || uri.startsWith('mongodb+srv:'),
      tlsAllowInvalidCertificates: false,
      tlsAllowInvalidHostnames: false,
    });
    try {
      await deadline(
        { ...o, timeoutMs: o.timeoutMs * 8 },
        async (signal) => {
          await c.connect();
          if (signal.aborted) {
            await c.close();
            throwIfAborted(signal);
          }
          const db = c.db();
          const stats = await db.command({ dbStats: 1, scale: 1, maxTimeMS: o.timeoutMs });
          s.metrics = [
            {
              label: 'Data size',
              value: n(stats.dataSize),
              unit: 'bytes',
              description: 'Uncompressed BSON data size.',
            },
            {
              label: 'Storage size',
              value: n(stats.storageSize),
              unit: 'bytes',
              description: 'Allocated collection storage.',
            },
            {
              label: 'Objects',
              value: n(stats.objects),
              description: 'Documents in the current database.',
            },
            {
              label: 'Indexes',
              value: n(stats.indexes),
              description: 'Total indexes in the database.',
            },
          ];
          await optional(s, 'Server metrics', uri, async () => {
            const v = await db.admin().command({ serverStatus: 1, maxTimeMS: o.timeoutMs });
            s.uptimeSeconds = n(v.uptime);
            s.metrics.push({
              label: 'Connections',
              value: n(v.connections?.current),
              description: 'Server-wide current connections.',
            });
          });
          await optional(s, 'Collections and indexes', uri, async () => {
            const cursor = db.listCollections(
              {},
              { nameOnly: true, batchSize: 100, maxTimeMS: o.timeoutMs },
            );
            const cols: { name: string; type?: string }[] = [];
            try {
              for await (const col of cursor) {
                cols.push(col);
                if (cols.length === 100) {
                  s.notices.push('Collection inventory limited to 100 objects.');
                  break;
                }
              }
            } finally {
              await cursor.close();
            }
            s.capabilities.push('tables', 'indexes');
            for (const col of cols) {
              throwIfAborted(signal);
              s.tables.push({
                name: col.name,
                rows: 0,
                sizeBytes: 0,
                scans: 0,
                indexScans: 0,
                deadRows: 0,
              });
              if (col.name === 'system.profile' || col.type === 'view' || s.indexes.length >= 500)
                continue;
              await optional(s, 'Indexes for ' + col.name, uri, async () => {
                const indexes = await db
                  .collection(col.name)
                  .listIndexes({ maxTimeMS: o.timeoutMs })
                  .toArray();
                for (const i of indexes.slice(0, 500 - s.indexes.length))
                  s.indexes.push({
                    name: i.name ?? '',
                    table: col.name,
                    scans: 0,
                    sizeBytes: 0,
                    definition: JSON.stringify(i.key),
                  });
              });
            }
            if (s.indexes.length >= 500) s.notices.push('Index inventory limited to 500 indexes.');
          });
          await optional(s, 'Existing profiler samples', uri, async () => {
            const docs = await db
              .collection('system.profile')
              .find(
                { op: { $in: ['query', 'command'] } },
                {
                  projection: { millis: 1, ns: 1, ts: 1, command: 1, nreturned: 1 },
                  maxTimeMS: o.timeoutMs,
                },
              )
              .sort({ ts: -1 })
              .limit(50)
              .toArray();
            s.queries = docs.map((r) => ({
              id: String(r._id),
              query: JSON.stringify(r.command ?? { ns: r.ns }).slice(0, 4000),
              calls: 1,
              totalMs: n(r.millis),
              meanMs: n(r.millis),
              rows: n(r.nreturned),
            }));
            s.capabilities.push('queries');
          });
          s.notices.push(
            'Profiler is never enabled automatically. Query data is individual recent profiler samples, not digest aggregates. Collection sizes and index usage are not collected.',
          );
        },
        () => {
          void c.close().catch(() => {});
        },
      );
    } finally {
      await c.close().catch(() => {});
    }
  } else if (p.engine === 'redis') {
    const c = createClient({
      url: redisTransportUri(uri, p.tls),
      socket: {
        connectTimeout: o.timeoutMs,
        reconnectStrategy: false,
        ...(p.tls || uri.startsWith('rediss:')
          ? { tls: true as const, rejectUnauthorized: true }
          : {}),
      },
    });
    c.on('error', () => {});
    try {
      await deadline(
        { ...o, timeoutMs: o.timeoutMs * 8 },
        async (signal) => {
          await c.connect();
          if (signal.aborted) {
            if (c.isOpen) c.destroy();
            throwIfAborted(signal);
          }
          const info = await deadline(
            { ...o, signal },
            () => c.info(),
            () => c.destroy(),
          );
          const v = Object.fromEntries(
            info
              .split(/\r?\n/)
              .filter((x) => x && !x.startsWith('#'))
              .map((x) => {
                const i = x.indexOf(':');
                return [x.slice(0, i), x.slice(i + 1)];
              }),
          );
          s.uptimeSeconds = n(v.uptime_in_seconds);
          if (v.run_id) s.serverIdentity = v.run_id;
          s.metrics = [
            {
              label: 'Memory used',
              value: n(v.used_memory),
              unit: 'bytes',
              description: 'Server-wide allocated memory.',
            },
            {
              label: 'Clients',
              value: n(v.connected_clients),
              description: 'Server-wide client count.',
            },
            {
              label: 'Operations / second',
              value: n(v.instantaneous_ops_per_sec),
              description: 'Redis instantaneous operation rate.',
            },
            {
              label: 'Cache hit ratio',
              value:
                Math.round(
                  (n(v.keyspace_hits) / Math.max(1, n(v.keyspace_hits) + n(v.keyspace_misses))) *
                    10000,
                ) / 100,
              unit: '%',
              description: 'Cumulative key lookup hit ratio.',
            },
            {
              label: 'Evicted keys',
              value: n(v.evicted_keys),
              description: 'Cumulative evictions under memory pressure.',
            },
          ];
          for (const [k, val] of Object.entries(v))
            if (/^db\d+$/.test(k))
              s.tables.push({
                name: k,
                rows: n(/keys=(\d+)/.exec(val)?.[1]),
                sizeBytes: 0,
                scans: 0,
                indexScans: 0,
                deadRows: 0,
                extra: val,
              });
          s.capabilities.push('tables');
          await optional(s, 'Slow log', uri, async () => {
            const logs = (await deadline(
              { ...o, signal },
              () => c.sendCommand(['SLOWLOG', 'GET', '50']),
              () => c.destroy(),
            )) as any[];
            s.queries = logs.map((r) => ({
              id: String(r[0]),
              query: (r[3] as string[]).map(String).join(' ').slice(0, 4000),
              calls: 1,
              totalMs: n(r[2]) / 1000,
              meanMs: n(r[2]) / 1000,
              rows: 0,
            }));
            s.capabilities.push('queries');
          });
          s.notices.push(
            'Redis metrics cover the server; keyspace lists logical databases. Slow log entries are individual executions and may contain sensitive command arguments. Keys are never scanned.',
          );
          if (n(v.evicted_keys) > 0)
            s.findings.push({
              severity: 'warning',
              title: 'Keys have been evicted',
              detail: `${v.evicted_keys} cumulative evictions.`,
              action: 'Review maxmemory, eviction policy and working-set size.',
            });
        },
        () => {
          if (c.isOpen) c.destroy();
        },
      );
    } finally {
      if (c.isOpen) c.destroy();
    }
  }
  s.findings.push(...findingsFor(s, o.slowQueryMs));
  s.timestamp = new Date().toISOString();
  return s;
}
export async function explain(
  p: Profile,
  uri: string,
  sql: string,
  execute: boolean,
  o: Options,
): Promise<Plan> {
  if (!['postgres', 'mysql', 'sqlserver', 'sqlite', 'demo'].includes(p.engine))
    throw new Error(
      'SQL plans are available for PostgreSQL, MySQL, SQL Server and SQLite. MongoDB and Redis have separate diagnostics.',
    );
  throwIfAborted(o.signal);
  const safe = validateSql(sql, p.engine);
  if (execute && p.engine !== 'postgres')
    throw new Error('Executed plans are supported only for PostgreSQL.');
  const started = Date.now();
  let raw: unknown;
  let nodes;
  if (p.engine === 'demo') {
    raw = [
      {
        Plan: {
          'Node Type': 'Seq Scan',
          'Relation Name': 'orders',
          'Plan Rows': 1450000,
          'Total Cost': 28420,
          Filter: 'created_at > timestamp',
          Plans: [],
        },
      },
    ];
    nodes = postgresPlan(raw);
  } else if (p.engine === 'postgres') {
    raw = await pgSession(uri, p, o, async (c) => {
      await c.query('BEGIN READ ONLY');
      try {
        const r = await c.query(
          `EXPLAIN (${execute ? 'ANALYZE, BUFFERS, ' : ''}FORMAT JSON) ${safe}`,
        );
        return r.rows[0]['QUERY PLAN'];
      } finally {
        await c.query('ROLLBACK').catch(() => {});
      }
    });
    nodes = postgresPlan(raw);
  } else if (p.engine === 'mysql') {
    raw = await mySession(uri, p, o, async (q) => {
      const r = await q('EXPLAIN FORMAT=JSON ' + safe);
      return JSON.parse(r[0].EXPLAIN);
    });
    nodes = genericPlan(raw);
  } else if (p.engine === 'sqlserver') {
    raw = await msSession(uri, p, o, async (q) => {
      await q('SET SHOWPLAN_XML ON');
      try {
        return await q(safe);
      } finally {
        await q('SET SHOWPLAN_XML OFF').catch(() => {});
      }
    });
    nodes = [
      {
        name: 'SQL Server estimated XML plan',
        detail: 'Open the raw plan to inspect operator details.',
        children: [],
      },
    ];
  } else {
    [raw] = await sqliteQueries(uri, o, ['EXPLAIN QUERY PLAN ' + safe]);
    nodes = (raw as Row[]).map((r) => ({
      name: r.detail,
      detail: `Parent: ${r.parent}`,
      children: [],
    }));
  }
  return {
    engine: p.engine,
    sql: safe,
    executed: execute,
    raw,
    nodes,
    findings: planFindings(nodes),
    elapsedMs: Date.now() - started,
  };
}

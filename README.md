# Database Performance Analyzer

Find expensive database work without leaving VS Code. **VS Code 1.71.2 is supported for PostgreSQL, MySQL/MariaDB, SQLite and demo. Use VS Code 1.101+ for all six engines.** A guided connection flow leads to a dashboard of query costs, sessions, storage, indexes and actionable performance observations.

Requires VS Code 1.101 or later (Node 22 extension host).

**Supported:** PostgreSQL 13+, MySQL 8+ / MariaDB with compatible Performance Schema, SQL Server 2019+, SQLite 3 files, MongoDB 6+, Redis 6+. Database distributions and services may expose fewer diagnostics. This is not universal support for every database product.

## Start in a minute

1. Install the VSIX with **Extensions → ⋯ → Install from VSIX…**, or run `code --install-extension database-performance-analyzer-1.4.0.vsix`.
2. Open **Database Performance** in the activity bar.
3. Choose **Explore Demo**, **Detect Project Databases**, or **Add Connection**.
4. Choose **Local database defaults**, **Guided connection setup**, **Detect from this project**, **Paste a connection URL**, or **Open a SQLite database file**. Name the connection and choose transport security. Guided setup safely encodes special characters in credentials.
5. Refresh once or enable monitoring. Review collection notices before interpreting missing metrics.

Use a dedicated account with only the required read and monitoring privileges. Passwords and complete URLs are saved in VS Code's encrypted SecretStorage. Non-secret connection names and target labels are stored in extension global state. Under Remote SSH or containers, database access runs on the workspace host; `localhost` refers to that host.

### Connection URLs

```text
postgresql://reader:password@localhost:5432/app
mysql://reader:password@localhost:3306/app
sqlserver://reader:password@localhost:1433/app
sqlite:///absolute/path/to/backup.sqlite
mongodb://reader:password@localhost:27017/app?authSource=admin
mongodb+srv://reader:password@cluster.example/app
redis://:password@localhost:6379/0
rediss://:password@redis.example:6380/0
```

TLS defaults to certificate verification. Plaintext is an explicit choice for local development or a trusted tunnel. Self-signed certificates must be trusted by the Node/OS trust configuration; certificate verification cannot be disabled in the extension. For Redis, the URL scheme is normalized to match the TLS choice. MySQL and SQL Server use the host, port, user, password and database fields; MySQL URL query parameters are not applied. SQL Server supports SQL authentication; integrated authentication and named instances are not included. MongoDB SRV and Redis `rediss` require TLS. PostgreSQL TLS URL parameters are removed in favor of the explicit TLS choice.

## What you can inspect

| Engine          | Query cost                             | Sessions / blockers                            | Objects & indexes                                                      | Query plans                                |
| --------------- | -------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------ |
| PostgreSQL      | `pg_stat_statements` digest statistics | Current sessions and blocker IDs               | Estimated rows, dead tuples, scans, sizes, index definitions and reads | JSON operator tree; optional executed plan |
| MySQL / MariaDB | Performance Schema digests             | Process list and wait states; no blocker graph | Estimated rows, sizes and index columns                                | Estimated JSON plan where supported        |
| SQL Server      | Plan-cache statement statistics        | Active requests and positive blocker IDs       | Partition row/size estimates; index reads                              | Estimated XML in raw plan viewer           |
| SQLite          | No runtime workload statistics         | Not collected                                  | Schema and index definitions from a file copy                          | `EXPLAIN QUERY PLAN`                       |
| MongoDB         | Existing profiler samples              | Not collected                                  | Collection names and index key definitions                             | SQL plans not applicable                   |
| Redis           | Existing slow-log samples              | Not collected                                  | Logical database key counts; no key scans                              | SQL plans not applicable                   |

Missing permissions or disabled features produce collection notices. The extension does not install extensions, enable profiling, reset statistics, create indexes, vacuum, terminate sessions or change server configuration. Object inventories are capped at 100 objects per collector; queries and slow-log samples at 50. MongoDB lists at most 100 collections for index inspection.

### Dashboard

- Metric cards explain their scope and units. Some metrics are server-wide.
- Select a chart metric to inspect its local history. Tabs support arrow-key, Home and End navigation.
- Findings cover expensive queries, blockers, idle transactions, dead tuples, unused index candidates and Redis evictions. They are advisory, not an exhaustive health audit.
- Query patterns filter and sort by cost, average latency or calls.
- Session, table and index inventories identify unavailable counters with a dash.
- **Set comparison baseline** then refresh to view interval deltas for matching cumulative query patterns. Server identities and query-statistics reset timestamps are checked when available. Counter resets, individual profiler/slow-log samples and missing patterns yield unavailable deltas.
- Live monitoring is opt-in, never overlaps collections, stops when hidden or cancelled and stops on a connection error. A failed refresh labels the retained snapshot as stale and offers Retry. Local history is bounded to the configured snapshots per connection, across ten recent connections, with a global 32 MB serialized-data budget. Older samples may be evicted before the sample-count limit. History is lost on reload.
- **Export report** produces Markdown, JSON or query CSV. Query text and session user names are omitted by default. Reports can still include object names, target labels, findings and server error descriptions; review before sharing. CSV formula cells are neutralized.

### Query analysis

Select a SELECT in a SQL editor and run **Database Performance: Explain Selected SQL**, or use the dashboard's plan editor. Supply representative literal values in place of application parameters or normalized digest placeholders.

Only a single parsable SELECT is accepted. Write statements, write CTEs, SELECT INTO, locking reads and known unsafe functions are rejected. This is a conservative SQL parser, not a complete security sandbox: use trusted SQL and a least-privilege account. Estimated EXPLAIN does not normally execute a query, but optimizers can evaluate functions. PostgreSQL runs plans inside a read-only transaction with timeouts and rollback. **EXPLAIN ANALYZE** explicitly executes the SELECT after a modal confirmation; functions may have external effects even in a read-only transaction.

SQL Server's SHOWPLAN connection is isolated to a single-connection pool and closed afterward. SQLite inspection uses a read-only in-memory copy, supports files up to 256 MB and refuses non-empty WAL or rollback-journal files. Use SQLite's backup facility to make a consistent copy of an active database. SQLite inspection runs in a separate worker, with deadline enforcement and termination on cancellation. File size, format, journal sidecars and file metadata are checked before accepting a copy. This reduces inconsistency risk but is not a database-level snapshot guarantee; use a consistent backup.

### Automatic project discovery

Detection reads up to 100 matching configuration/model files, each at most 1 MB, excluding common dependency/build directories. It recognizes literal URLs in `.env`, Prisma, compose and supported configuration files, plus Prisma, TypeORM, Sequelize, Mongoose, Knex, Drizzle, Django and database driver dependencies. It extracts Prisma model names, Django models, TypeORM entity class names and Mongoose model declarations using conservative text matching.

Discovery never executes project code, evaluates environment substitutions or opens a network connection. Review and save a detected URL before it is used. Dynamic configuration, separate host/password fields, unusual file naming, JDBC URLs, embedded code and unsupported engines need manual setup. Detection may identify a dependency even when that framework is not actively used.

## Database permissions and setup

- **PostgreSQL:** Basic catalog access works for your own sessions. `pg_read_all_stats` / `pg_monitor` enables broader monitoring. `pg_stat_statements` must be installed by your DBA and loaded through `shared_preload_libraries`; the extension never changes these settings. Statistics use execution-time columns introduced in PostgreSQL 13.
- **MySQL:** SELECT on required `performance_schema` tables and metadata access; PROCESS for broader process visibility. Performance Schema statement digests must be enabled. Compatible MariaDB versions may differ and return a notice.
- **SQL Server:** Metadata visibility plus VIEW DATABASE STATE / VIEW SERVER STATE, or corresponding PERFORMANCE STATE permissions on newer versions, for the relevant DMVs. SHOWPLAN on the referenced database is needed for estimated plans.
- **MongoDB:** Read access to the database metadata and existing `system.profile`; monitoring privileges for `serverStatus`. Profiling is never turned on. Command bodies may contain sensitive document filters.
- **Redis:** Allow INFO and SLOWLOG GET on a dedicated ACL account. The extension never uses KEYS or modifies slow-log settings. Slow logs may include sensitive arguments.
- **SQLite:** Read access to a consistent local file. Remote filesystem access depends on the workspace host.

## Settings

| Setting                         | Default | Purpose                                                             |
| ------------------------------- | ------- | ------------------------------------------------------------------- |
| `dbPerf.queryTimeoutMs`         | 10000   | Timeout per network query; bounded multi-query collection deadlines |
| `dbPerf.refreshIntervalSeconds` | 30      | Opt-in monitoring interval, 5–300 seconds                           |
| `dbPerf.slowQueryMs`            | 100     | Advisory mean latency threshold                                     |
| `dbPerf.maxHistory`             | 60      | In-memory snapshots per connection, 5–300                           |

## Develop and verify

```sh
npm ci
npm run verify
npm run test:integration
npm run test:host
npm run package
```

Press F5 to open an Extension Development Host. Host tests require a graphical session; use `xvfb-run -a npm run test:host` in headless Linux. Database integration tests always exercise SQLite; stalled-connection timeout/cancellation fixtures run when `DBPERF_TEST_FAILURES=1`, and live network engine tests run when their `DBPERF_TEST_*_URL` variables are supplied. The CI workflow provisions PostgreSQL, MySQL, MongoDB and Redis. SQL Server coverage requires a licensed test instance and `DBPERF_TEST_SQLSERVER_URL`.

Drivers and their license notices are bundled into the VSIX. No database credentials, `.env` files, tests or development dependencies are packaged.

## Publishing

The configured publisher ID is `DaniyalMusadiq`. Marketplace publication requires membership of that publisher and local authentication. See `PUBLISHING.md` for publishing instructions. Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=DaniyalMusadiq.database-performance-analyzer), or use the local VSIX package.

### Easier dashboard controls in 1.2

- Explore the demo in Restricted Mode; connecting or detecting project databases requires workspace trust.
- Use **Manage connection** to rename a saved connection, update its URL, change TLS or remove it. Connection changes clear old statistics before refreshing.
- Filter findings by severity and search sessions, tables and indexes. Query counts show how many patterns match your search.
- Clear the comparison baseline or local chart history without resetting database statistics.
- Open extension settings directly from the dashboard. The connection summary shows its target and transport security.
- Failed-refresh warnings remain visible when the webview reconnects. Replace query placeholders with representative literals before requesting a plan.

### Dynamic controls in 1.3

Click a finding summary to view that severity. Diagnostic tabs show available record counts. **Slow only** filters query patterns using `dbPerf.slowQueryMs`; use **Highest first / Lowest first** to reverse sorting. Choose a monitoring interval directly from the toolbar and watch the countdown. Stop monitoring stays available during collection; **Cancel** also interrupts the current operation.

History charts show minimum, maximum and latest values. Hover over a point for its capture time and value. History is local and lost on reload; it represents collected samples rather than continuous server measurements.

Source and issue reports: [GitHub repository](https://github.com/DaniyalMusadiq1/Database-Performance-Analyzer).

### Compatibility and connection guidance in 1.4

| Editor / extension-host runtime | Available engines                       |
| ------------------------------- | --------------------------------------- |
| VS Code 1.71.2 / Node 16.14.2   | PostgreSQL, MySQL/MariaDB, SQLite, demo |
| Node 20.19+                     | Core engines plus MongoDB and Redis     |
| VS Code 1.101+ / Node 22+       | All six engines                         |

The extension now compiles against the VS Code 1.71 API and builds for Node 16.14. Modern drivers are loaded only when used and checked against their runtime requirements. It does not downgrade database drivers to obsolete versions.

**Local database defaults** skips host and port entry. Guided setup has Back buttons, individual validation and field explanations. **Manage connection → Edit connection fields** lets you change host, port, database and username; leaving the password blank keeps the stored password. Connection URL options are preserved. Use **Update connection URL** for MongoDB SRV/cluster URLs or to remove an existing password. Changes save securely and refresh the selected connection automatically.

Hover over dashboard controls for tooltips, or expand **Connection guide & troubleshooting** for examples and advice.

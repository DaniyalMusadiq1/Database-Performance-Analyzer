# Release validation

Development environment: Linux x64, Node 24.21.0, VS Code 1.141.0. Minimum editor: VS Code 1.71.2 / Node 16.14.2 for core engines. All six engines require VS Code 1.101+ / Node 22+. Tests and source are included in the repository, not in the VSIX.

## Completed locally

- TypeScript strict compilation and bundled build including all six engine drivers.
- Thirty-five unit checks (expanded in 1.4.0): engine detection, URL validation and error redaction, accepted SELECT/CTE statements, write/locking/unsafe-function rejection, CSV/HTML escaping, findings, counter comparisons/reset handling, nested PostgreSQL plans, report privacy, discovery/model detection formatting dependency bounds, cancellation/resource races, global history budgets, corrupted state, serialized saves, unsafe commented/quoted functions, encoded TLS options invalid settings, guided connection credential encoding and malformed host/port rejection, runtime compatibility guards and preservation of credentials/URL options during guided editing.
- Eleven stalled-connection fixture checks across PostgreSQL, MySQL, SQL Server, MongoDB and Redis: timeout/cancellation close all sockets, and Redis verified TLS sends a TLS handshake for redis:// input. These are protocol failure fixtures, not successful live-engine coverage.
- SQLite worker: expensive execution is terminated at its deadline while the parent event loop remains responsive; pre-cancelled work never starts.
- Real SQLite file: schema/index inventory, index-assisted query plan, unchanged source bytes and active-WAL rejection.
- Isolated PostgreSQL 18: live collection, estimated JSON plan, explicitly executed read-only plan and write statement rejection. The temporary test server and its data directory are cleaned afterward. pg_stat_statements was enabled; query statistics, its reset timestamp and server identity were verified. Missing optional statistics remain a collection notice.
- VS Code 1.141 extension-host test: manifest registration, activation, command registration demo dashboard creation and bundled SQLite worker/WASM execution inside the extension host.
- Headless Chrome: welcome/setup controls, demo metrics/findings, tab navigation, query filtering, SQL plan actions, hostile text rendering, stale metric clearing on connection switch and stale-data retry/recovery, selectable chart metrics, keyboard navigation and desktop/narrow layout screenshots, Restricted Mode controls, severity/object filters, baseline clearing, connection management and settings actions, clickable severity summaries, ascending query sorting, slow-only filtering, inline monitoring controls and multi-sample chart tooltips, legacy-runtime notices, disabled unsupported-engine actions and connection help/tooltips.
- Dependencies bundled with generated license notices; packaged formatter mitigation is unit-tested. The audit still reports the upstream moderate advisory as explained in SECURITY.md.

## Automated coverage available, not executed locally

Network integration tests accept `DBPERF_TEST_POSTGRES_URL`, `DBPERF_TEST_MYSQL_URL`, `DBPERF_TEST_SQLSERVER_URL`, `DBPERF_TEST_MONGODB_URL`, and `DBPERF_TEST_REDIS_URL`. Without a configured endpoint, those tests explicitly skip.

The GitHub Actions workflow provisions PostgreSQL 16, MySQL 8.4, MongoDB 7 and Redis 7, runs integration and extension-host tests, checks browser interactions and uploads a VSIX. It has not been executed on GitHub in this session. SQL Server needs a separately provided instance.

## Required before claiming full production certification

- Run live MySQL/MariaDB, SQL Server, MongoDB and Redis tests with representative privileges and TLS. These engines were bundled and statically checked but no live instance was available locally.
- Verify enabled pg_stat_statements and restricted pg_monitor users; validate workload/reset counters and load impact.
- Test SQL Server SHOWPLAN pool behavior against a real SQL Server instance and validate permissions on each supported server version.
- Exercise MongoDB profiler visibility and Redis ACL denial on real servers. Enable `DBPERF_TEST_FAILURES=1` to rerun the local stalled-socket fixtures.
- Test Windows/macOS, Remote SSH/containers, custom certificate trust, VS Code 1.101 and current stable, SecretStorage persistence and credential rotation.
- Extend the already verified stalled-connection cancellation tests to authenticated active queries on each live engine, simultaneous UI actions and realistic workload size.
- Use a fresh VS Code profile to test the packaged VSIX. Complete Marketplace identity, repository metadata and public listing review.

The extension is a functioning installable release candidate with production-oriented safeguards. The remaining matrix should be completed before describing it as certified production-ready for every supported engine.

## VS Code 1.71.2 compatibility

An isolated official VS Code 1.71.2 copy exercises activation, command registration, demo, the bundled SQLite worker, real SQLite schema inspection and SELECT query plans, plus PostgreSQL/MySQL stalled-endpoint connection timeouts. Unsupported modern engines return upgrade guidance before initializing their drivers. The extension is compiled against `@types/vscode` 1.71.0. Full live PostgreSQL/MySQL success and TLS testing on the old host, and Windows/macOS validation, remain outstanding.

## 1.8.0 validation (October 12, 2026)

- Strict TypeScript check, 43 unit tests and bundled build passed on Linux / Node 24.19.0.
- Integration suite: 13 passed (SQLite file/worker checks plus network timeout/cancellation/TLS fixtures); five live-server tests skipped because endpoints were not configured.
- Installed VS Code 1.134.0 / Node 24.18.1 host test passed activation, commands, demo dashboard, bundled SQLite and PostgreSQL/MySQL timeout checks.
- Browser regression coverage expanded for Simple/Advanced view, administrator request, retained connection fields, readable errors and limited diagnostic readiness. Desktop and narrow screenshots are generated by the browser suite.
- This release does not claim new successful live-server validation for PostgreSQL, MySQL, SQL Server, MongoDB or Redis, or nontechnical-user usability testing. The outstanding platform/server matrix above remains applicable.

## 1.9.0 validation (October 12, 2026)

- Strict TypeScript, 45 unit tests, build and browser regression checks passed.
- Browser checks cover unsupported connection links, detection, show/hide credentials, clearing on close, and switching from invalid hidden port fields to connection-link setup.
- Integration suite: 13 passed; five live-server tests skipped without endpoints. Local socket fixtures require execution outside the restricted sandbox.
- New analysis regressions cover quiet intervals, reused query IDs, invalid numeric counters and inconsistent counter changes.
- The existing live-server and cross-platform validation limitations remain unchanged.

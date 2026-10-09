# Changelog

## 1.5.0

- Add permanent sidebar shortcuts for dashboard, connection setup, project detection and demo.
- Add a sidebar title button for opening the dashboard and rename the view to Dashboard & connections.
- Activate after startup so the DB Performance status-bar shortcut is available without opening the Command Palette.
- Add a one-time welcome notification with Open Dashboard and Try Demo actions.
- Add optional dashboard home-screen opening on startup without connecting or starting monitoring.
- Keep VS Code 1.71.2 core-engine compatibility.

## 1.4.0

- Support installation on VS Code 1.71.2 with PostgreSQL, MySQL/MariaDB, SQLite and demo.
- Compile against the 1.71 API, add explicit command activation events, target Node 16.14 and use compatible snapshot cloning.
- Lazy-load modern MongoDB, Redis and SQL Server drivers; guard their runtime requirements and explain upgrade requirements in the dashboard.
- Add local database defaults and direct project detection to the connection chooser.
- Add guided setup with Back buttons, per-field validation and explanatory prompts.
- Add guided editing of saved connection fields with retained passwords, preserved URL options and automatic refresh after updates.
- Add dashboard tooltips, connection examples and a troubleshooting guide.
- Test activation, SQLite collection/query plans and unsupported-engine guards on actual VS Code 1.71.2; add legacy-host CI coverage.

## 1.3.0

- Add clickable critical/warning/information summaries and record counts in diagnostic tabs.
- Add a slow-query filter based on the configured latency threshold and reversible query sorting.
- Add inline monitoring interval selection, a countdown tied to the extension host timer, and a stop control that stays available during collection.
- Improve chart readability with minimum, maximum and latest values, per-sample tooltips, finite-value validation and centered constant series.
- Show chart empty-state instructions as readable text at narrow widths.
- Link the GitHub repository and issue tracker from the Marketplace manifest.
- Expand browser workflow tests for summaries, sorting, slow filters, charts and monitoring controls.

## 1.2.0

- Add guided field-based network connection setup with encoded credentials and IPv6 support, plus a SQLite file picker.
- Make the dashboard and synthetic demo available in Restricted Mode while protecting real database access and discovery with workspace trust.
- Add dashboard connection management: rename, update URL, change verified TLS and remove.
- Add connection security summaries, direct settings access, severity filters and searches for sessions, tables and indexes.
- Add clear-baseline and clear-history actions, query match counts and sample/cumulative statistics descriptions.
- Preserve refresh error state across dashboard reloads and clear filters and SQL when switching connections.
- Expand guided connection and dashboard workflow regression checks.

## 1.1.0

- Fix cancellation/startup races, cleanup of late connections and timeout propagation.
- Run SQLite loading and queries in a cancellable worker; validate file format, bounded reads and WAL/journal consistency checks.
- Cancel SQL Server requests directly and bound MongoDB collection/index inventories.
- Fix Redis verified-TLS scheme mismatch and IPv6 host handling.
- Strengthen SQL function validation and reject executable SQL comments and encoded TLS bypass options.
- Track PostgreSQL statistics reset timestamps and server identities; prevent sample/cumulative comparison mixups.
- Cap snapshot history by a global byte budget and send only metric history to the webview.
- Serialize profile storage changes, roll back failed credential updates and validate restored profiles/settings.
- Add stale snapshot notices, retry controls, selectable chart metrics and keyboard tab navigation.
- Expand unit, worker, stalled-connection and dashboard regression coverage.

## 1.0.0

- Six engine adapters: PostgreSQL, MySQL/MariaDB, SQL Server, SQLite, MongoDB and Redis.
- Guided URL-based connection setup with VS Code SecretStorage and verified TLS.
- Project connection and ORM model discovery without executing project code.
- Interactive performance dashboard, advisory findings, local history and counter comparisons.
- Estimated SQL plans and explicitly confirmed PostgreSQL EXPLAIN ANALYZE.
- Markdown, JSON and CSV reports with optional query text.
- Read-only collectors, timeouts, cancellation, capability notices and no telemetry.
- Synthetic demo dashboard and repeatable build/test/package workflows.

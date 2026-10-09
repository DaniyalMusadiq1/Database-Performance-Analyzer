# Security design and dependency status

Database Performance Analyzer stores complete connection URLs in VS Code SecretStorage. Profile names, engine types and credential-free target labels are kept in extension global state. Collectors send data only to the configured endpoint. The extension has no telemetry or remote AI service.

## Boundaries

- Trusted workspaces are required for real database access, connection changes and project discovery. The dashboard, synthetic demo and demo reports are available in Restricted Mode. Project discovery reads bounded files as text and never evaluates code.
- Credentials are not posted to the webview. Error messages are sanitized before display/logging. Query texts and server diagnostic messages can still contain sensitive business data; review before sharing.
- Webview CSP denies default network access, scripts require a random nonce, and database/project strings render through textContent. No command URIs are enabled.
- TLS verifies server certificates. Redis schemes are normalized to match selected transport; MongoDB verification bypass options are checked after URL decoding. PostgreSQL URL SSL/session options are stripped to enforce explicit security and timeout settings. MongoDB insecure TLS options are rejected.
- SQL is parsed as a single SELECT; disallowed AST nodes, executable MySQL comments and known dangerous function calls (including quoted/qualified/comment-separated forms) are rejected. Locking clauses are rejected. This is a guardrail, not a complete sandbox. Unknown functions may have effects; analyze only trusted queries with a least-privilege account.
- PostgreSQL collections set read-only session defaults and plans use a read-only transaction with rollback. MySQL collections use read-only transaction defaults. SQL Server collectors use fixed SELECTs and estimated SHOWPLAN only. MongoDB/Redis issue fixed inspection commands, never profiling configuration or mutations. SQLite uses a query-only in-memory copy.
- Live collectors have scoped timeouts, bounded lists, cancellation and cleanup. Resources finishing acquisition after cancellation are disposed before use. SQL Server cancels the active request. MongoDB views are skipped, index visibility failures are isolated per collection, and inventories are capped. SQLite work runs in a worker that is terminated on deadline/cancellation; the extension host stays responsive. Backup files are checked for format, size, changing metadata and active WAL/rollback journals. These checks do not replace SQLite backup consistency guarantees.
- CSV exports neutralize leading spreadsheet formula characters. Query/session text is opt-in in exports; metadata is still present.

## Known npm advisory: mitigated in packaged build

The audit on October 9, 2026 reports three moderate dependency entries (`mssql` → `tedious` → `sprintf-js`) from one upstream advisory: [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c). The installed `sprintf-js` version is 1.1.3; npm offered no compatible fixed version. Automatic audit remediation would downgrade the SQL Server driver across major versions and is not appropriate.

The packaged build transforms the original BSD-licensed formatter with a limit of 10,000 on width/precision. `scripts/harden-format.mjs` fails closed if the upstream source signature changes. A test verifies oversized widths/precision are rejected and ordinary driver formats remain correct. SQL Server's current driver call sites use static internal format strings, and the extension does not expose sprintf formatting to users.

**npm audit still reports the upstream dependency entries.** The mitigation applies to `npm run build` / VSIX bundles, not direct imports of the unmodified package in development integration tests. Reassess this mitigation when upstream releases a fix. Do not claim a zero-advisory dependency tree.

Bundled dependency license texts are generated in `THIRD_PARTY_NOTICES.md`. Build metadata is excluded from the VSIX. The placeholder publisher is blocked by the publish script until replaced with a registered identity.

## Before public release

Validate least-privilege permissions and TLS on real production-like instances for every supported engine, verify Windows/macOS and remote host behavior, rerun dependency audits, and test the packaged artifact in a fresh VS Code profile. See `VALIDATION.md` for completed and outstanding coverage. Do not use the extension as an authorization boundary or a replacement for operational database monitoring.

## Legacy editor support

VS Code 1.71.2 can use core engines and demo. Modern drivers keep their existing versions and are lazy-loaded after runtime checks; older hosts receive upgrade instructions for unavailable engines. Guided editing does not display the saved password; a blank replacement keeps it. Complete URLs and passwords stay in SecretStorage and never enter dashboard messages. Guided changes retain existing URL options.

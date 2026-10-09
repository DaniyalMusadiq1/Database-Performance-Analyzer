#!/usr/bin/env bash
set -euo pipefail
pgbin=${DBPERF_PG_BIN:-/usr/lib/postgresql/18/bin}
testdir=$(mktemp -d /tmp/dbperf-postgres.XXXXXX)
cleanup() { "$pgbin/pg_ctl" -D "$testdir/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$testdir"; }
trap cleanup EXIT
"$pgbin/initdb" -D "$testdir/data" -A trust --no-locale > "$testdir/init.log"
"$pgbin/pg_ctl" -D "$testdir/data" -l "$testdir/server.log" -o "-p 55439 -h 127.0.0.1 -k $testdir -c shared_preload_libraries=pg_stat_statements" start
"$pgbin/psql" -h 127.0.0.1 -p 55439 -d postgres -c 'CREATE EXTENSION pg_stat_statements; CREATE TABLE dbperf_test(id integer PRIMARY KEY, value text); INSERT INTO dbperf_test SELECT i, md5(i::text) FROM generate_series(1,1000) i; ANALYZE dbperf_test;'
DBPERF_TEST_PG_STATEMENTS=1 DBPERF_TEST_POSTGRES_URL="postgres://$(id -un)@127.0.0.1:55439/postgres" npm run test:integration

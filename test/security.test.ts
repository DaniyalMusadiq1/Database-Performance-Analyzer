import test from 'node:test';
import { redisTransportUri, networkHostname } from '../src/security';
import assert from 'node:assert/strict';
import {
  detectEngine,
  targetOf,
  validateSql,
  validateUri,
  redactError,
  csvCell,
  escapeHtml,
} from '../src/security';
test('Detects all supported engines and keeps credentials out of target labels', () => {
  for (const [url, engine] of [
    ['postgresql://alice:secret@localhost:5432/app', 'postgres'],
    ['mysql://u:p@host/db', 'mysql'],
    ['mssql://u:p@host/db', 'sqlserver'],
    ['sqlite:///tmp/a.db', 'sqlite'],
    ['mongodb+srv://u:p@cluster/db', 'mongodb'],
    ['rediss://:p@host:6379', 'redis'],
  ])
    assert.equal(detectEngine(url), engine);
  assert.equal(targetOf('postgres://u:p@localhost/db?password=secret'), 'localhost/db');
  assert.throws(() => detectEngine('http://host'));
});
test('Allows a single SELECT and read-only CTE', () => {
  for (const e of ['postgres', 'mysql', 'sqlserver', 'sqlite'] as const) {
    assert.equal(validateSql('SELECT 1;', e), 'SELECT 1');
    assert.ok(validateSql('SELECT id FROM orders WHERE id = 42', e));
  }
  assert.ok(validateSql('WITH recent AS (SELECT id FROM orders) SELECT * FROM recent', 'postgres'));
});
test('Rejects mutations, multiple statements, locking reads and risky functions', () => {
  for (const sql of [
    'DELETE FROM orders',
    'SELECT 1; DROP TABLE orders',
    'SELECT * FROM orders FOR UPDATE',
    'SELECT pg_sleep(100)',
    "SELECT set_config('statement_timeout','0',true)",
    "SELECT lo_export(1, '/tmp/pwn')",
    'WITH x AS (DELETE FROM orders RETURNING *) SELECT * FROM x',
    'SELECT * INTO new_table FROM orders',
  ])
    assert.throws(() => validateSql(sql, 'postgres'), sql);
  assert.throws(() => validateSql("SELECT * FROM users INTO OUTFILE '/tmp/output'", 'mysql'));
});
test('Validates URLs and redacts connection errors', () => {
  validateUri('postgres://u:p@localhost/db');
  assert.throws(() => validateUri('sqlite://relative.db'));
  const message = redactError(
    new Error('failed postgres://alice:se%63ret@localhost/db?token=abc123 secret abc123'),
    'postgres://alice:se%63ret@localhost/db?token=abc123',
  );
  assert.ok(!message.includes('secret'));
  assert.ok(!message.includes('abc123'));
  assert.ok(!message.includes('alice'));
});
test('CSV formula injection and HTML payloads are escaped', () => {
  assert.equal(csvCell('=HYPERLINK("evil")'), '"\'=HYPERLINK(""evil"")"');
  assert.equal(escapeHtml('<script>"x"</script>'), '&lt;script&gt;&quot;x&quot;&lt;/script&gt;');
});

test('Unsafe functions remain blocked with comments, qualification and quoted names', () => {
  for (const sql of [
    'SELECT "pg_sleep"(1)',
    'SELECT pg_catalog.pg_sleep /* comment */ (1)',
    "SELECT pg_catalog.\"set_config\"('statement_timeout','0',true)",
  ])
    assert.throws(() => validateSql(sql, 'postgres'), /function/);
  assert.equal(
    validateSql("SELECT 'pg_sleep(1)' AS description", 'postgres'),
    "SELECT 'pg_sleep(1)' AS description",
  );
  assert.throws(
    () => validateSql('SELECT 1 /*! UNION SELECT SLEEP(100) */', 'mysql'),
    /Executable/,
  );
});
test('Invalid local file and fragmented connection URLs are rejected', () => {
  for (const uri of [
    'sqlite://host/tmp/db.sqlite',
    'sqlite:///tmp/db.sqlite?password=secret',
    'postgres://u:p@host/db#unencoded',
  ])
    assert.throws(() => validateUri(uri));
});

test('Verified Redis transport preserves credentials and uses the matching URL scheme', () => {
  assert.equal(
    redisTransportUri('redis://user:pa%40ss@host:6380/2', true),
    'rediss://user:pa%40ss@host:6380/2',
  );
  assert.equal(redisTransportUri('redis://host/0', false), 'redis://host/0');
  assert.equal(networkHostname('mysql://u:p@[::1]:3306/app'), '::1');
  assert.throws(() => validateUri('redis://host/test'), /numeric/);
});
test('Encoded MongoDB TLS bypass options cannot disable verification', () => {
  for (const uri of [
    'mongodb://u:p@host/app?tls%49nsecure=tr%75e',
    'mongodb://u:p@host/app?tlsAllowInvalidCertificates=1',
    'mongodb://u:p@host/app?tlsAllowInvalidHostnames=TRUE',
  ])
    assert.throws(() => validateUri(uri), /verification/);
  validateUri('mongodb://u:p@host/app?tlsAllowInvalidCertificates=false');
});

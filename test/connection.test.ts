import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConnectionUri, connectionDefaults, NetworkEngine } from '../src/connection';
import { detectEngine } from '../src/security';
test('Guided setup produces valid URLs for all network engines without changing credentials', () => {
  for (const engine of Object.keys(connectionDefaults) as NetworkEngine[]) {
    const d = connectionDefaults[engine];
    const uri = buildConnectionUri(
      engine,
      'localhost',
      String(d.port),
      d.database,
      'user@example',
      'a:b/@?# %',
    );
    assert.equal(detectEngine(uri), engine);
    const parsed = new URL(uri);
    assert.equal(decodeURIComponent(parsed.username), 'user@example');
    assert.equal(decodeURIComponent(parsed.password), 'a:b/@?# %');
    assert.equal(parsed.hostname, 'localhost');
  }
  assert.equal(
    new URL(buildConnectionUri('postgres', '::1', '5432', 'a/b', 'u', 'p')).hostname,
    '[::1]',
  );
  assert.equal(
    new URL(buildConnectionUri('redis', 'localhost', '6379', '0', '', 'secret')).password,
    'secret',
  );
});
test('Guided setup rejects ambiguous hosts, invalid ports and invalid Redis databases', () => {
  for (const host of ['localhost:5432', 'https://example.com', 'user@host', 'host/path', ''])
    assert.throws(() => buildConnectionUri('postgres', host, '5432', 'db', 'user', 'secret'));
  for (const port of ['0', '65536', '-1', '1.5', '', '5432evil'])
    assert.throws(() => buildConnectionUri('mysql', 'localhost', port, 'db', 'u', 'p'));
  assert.throws(() => buildConnectionUri('redis', 'localhost', '6379', '-1', '', ''));
  assert.throws(() => buildConnectionUri('postgres', 'localhost', '5432', 'db', '', 'secret'));
});

test('Guided editing preserves credentials, URL options and secure Redis transport', async () => {
  const { connectionFields, preserveConnectionOptions } = await import('../src/connection.js');
  const original =
    'postgresql://user%40domain:p%3A%2F%3F@host:5433/my%20db?application_name=my-app&sslmode=require';
  const fields = connectionFields(original);
  assert.equal(fields.user, 'user@domain');
  assert.equal(fields.password, 'p:/?');
  assert.equal(fields.database, 'my db');
  assert.equal(fields.port, '5433');
  const changed = preserveConnectionOptions(
    original,
    buildConnectionUri(
      fields.engine,
      'newhost',
      fields.port,
      fields.database,
      fields.user,
      fields.password,
    ),
  );
  assert.equal(new URL(changed).hostname, 'newhost');
  assert.equal(new URL(changed).searchParams.get('application_name'), 'my-app');
  assert.equal(new URL(changed).searchParams.get('sslmode'), 'require');
  assert.match(
    preserveConnectionOptions('rediss://localhost:6379/0', 'redis://other:6379/1'),
    /^rediss:/,
  );
  assert.throws(() => connectionFields('mongodb+srv://cluster.example/app'), /URL/);
  assert.throws(() => connectionFields('mongodb://one:27017,two:27017/app'));
});

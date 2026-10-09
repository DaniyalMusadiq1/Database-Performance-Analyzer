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

import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectFiles } from '../src/discovery';
test('dotenv split fields are discovered and credentials encoded without appearing in target', () => {
  const result = inspectFiles([
    {
      path: '.env',
      text: 'DB_CONNECTION=pgsql\nDB_HOST=localhost\nDB_DATABASE=app\nDB_USERNAME=user\nDB_PASSWORD="p@ss # word"',
    },
  ]);
  assert.equal(result.connections.length, 1);
  assert.equal(new URL(result.connections[0].uri).port, '5432');
  assert.equal(decodeURIComponent(new URL(result.connections[0].uri).password), 'p@ss # word');
  assert.equal(result.connections[0].target, 'localhost:5432/app');
});
test('discovery skips unresolved fields and invalid URLs and deduplicates results', () => {
  const result = inspectFiles([
    {
      path: '.env',
      text: 'DB_CONNECTION=mysql\nDB_HOST=${HOST}\nDATABASE_URL=postgresql://localhost:5432/app\nOTHER=postgresql://localhost:5432/app\nBAD=redis://localhost/not-a-number',
    },
  ]);
  assert.equal(result.connections.length, 1);
});

test('native driver environment fields detect multiple databases and preserve dollar passwords', () => {
  const result = inspectFiles([
    {
      path: 'app/.env.local',
      text: 'PGHOST=localhost\nPGDATABASE=app\nPGUSER=reader\nPGPASSWORD="p$word"\nREDIS_HOST=localhost\nMYSQL_HOST=localhost\nMYSQL_DATABASE=shop\nMYSQL_USER=root',
    },
  ]);
  assert.deepEqual(
    result.connections.map((c) => c.engine),
    ['postgres', 'mysql', 'redis'],
  );
  assert.equal(decodeURIComponent(new URL(result.connections[0].uri).password), 'p$word');
});

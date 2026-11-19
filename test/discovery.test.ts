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

test('detects additional native environment fields and URLs in application configuration', () => {
  const result = inspectFiles([
    {
      path: '.env.local',
      text: 'POSTGRES_HOST=db.local\nPOSTGRES_DB=app\nPOSTGRES_USER=reader\nPOSTGRES_PASSWORD=secret\nMONGODB_HOST=mongo.local\nMONGODB_DATABASE=inventory',
    },
    {
      path: 'application.properties',
      text: 'database.url=postgresql://reader@db.example.internal:5432/app',
    },
  ]);
  assert.deepEqual(
    result.connections.map((c) => c.engine),
    ['postgres', 'mongodb', 'postgres'],
  );
  assert.equal(result.connections[0].target, 'db.local:5432/app');
  assert.equal(result.connections[1].target, 'mongo.local:27017/inventory');
});

test('discovery ignores commented and JDBC URLs and handles Windows dotenv paths', () => {
  const result = inspectFiles([
    {
      path: 'project\\.env.local',
      text: '# DATABASE_URL=postgresql://localhost/ignored\nDB_CONNECTION=MYSQL\nDB_HOST=db.local\nDB_DATABASE=shop',
    },
    {
      path: 'application.properties',
      text: 'spring.datasource.url=jdbc:postgresql://db.local:5432/app',
    },
  ]);
  assert.deepEqual(
    result.connections.map((c) => c.engine),
    ['mysql'],
  );
  assert.ok(result.notices.some((notice) => notice.includes('JDBC address')));
});

test('does not combine unrelated PostgreSQL credential families', () => {
  const result = inspectFiles([
    {
      path: '.env',
      text: 'PGHOST=first.local\nPOSTGRES_HOST=second.local\nPOSTGRES_USER=other\nPOSTGRES_PASSWORD=secret',
    },
  ]);
  const uri = new URL(result.connections[0].uri);
  assert.equal(uri.hostname, 'first.local');
  assert.equal(uri.username, '');
  assert.equal(uri.password, '');
});

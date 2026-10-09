import test from 'node:test';
import assert from 'node:assert/strict';
import initSqlJs from 'sql.js';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { collect, explain } from '../../src/adapters';
import { sqliteQueries } from '../../src/sqlite';
import { Profile, Options } from '../../src/types';
test('SQLite real file inspection and plan leave the file unchanged', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dbperf-'));
  try {
    const wasmPath = resolve('node_modules/sql.js/dist/sql-wasm.wasm'),
      SQL = await initSqlJs({ locateFile: () => wasmPath }),
      db = new SQL.Database();
    db.run(
      'CREATE TABLE orders(id INTEGER PRIMARY KEY,customer_id INTEGER); CREATE INDEX orders_customer ON orders(customer_id); INSERT INTO orders VALUES(1,42)',
    );
    const buffer = Buffer.from(db.export());
    db.close();
    const path = join(dir, 'sample.sqlite');
    await writeFile(path, buffer);
    const uri = pathToFileURL(path)
      .toString()
      .replace(/^file:/, 'sqlite:');
    const p: Profile = {
      id: 'test',
      name: 'SQLite test',
      engine: 'sqlite',
      target: 'local',
      tls: false,
      createdAt: '',
    };
    const o: Options = {
      timeoutMs: 1000,
      slowQueryMs: 100,
      wasmPath,
      sqliteWorkerPath: resolve('dist/sqlite-worker.js'),
    };
    const s = await collect(p, uri, o);
    assert.ok(s.tables.some((t) => t.name === 'orders'));
    assert.ok(s.indexes.some((i) => i.name === 'orders_customer'));
    const plan = await explain(p, uri, 'SELECT * FROM orders WHERE customer_id = 42', false, o);
    assert.ok(plan.nodes.some((n) => n.name.includes('orders_customer')));
    assert.deepEqual(await readFile(path), buffer);
    await writeFile(path + '-wal', 'active');
    await assert.rejects(collect(p, uri, o), /active WAL/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('SQLite worker cancels expensive execution without freezing the caller', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dbperf-worker-'));
  try {
    const wasmPath = resolve('dist/sql-wasm.wasm'),
      SQL = await initSqlJs({ locateFile: () => wasmPath }),
      db = new SQL.Database();
    db.run('CREATE TABLE fixture(id INTEGER)');
    const path = join(dir, 'test.sqlite');
    await writeFile(path, Buffer.from(db.export()));
    db.close();
    const uri = pathToFileURL(path)
      .toString()
      .replace(/^file:/, 'sqlite:');
    const o: Options = {
      timeoutMs: 700,
      slowQueryMs: 100,
      wasmPath,
      sqliteWorkerPath: resolve('dist/sqlite-worker.js'),
    };
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    try {
      await assert.rejects(
        sqliteQueries(uri, o, [
          'WITH RECURSIVE cnt(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM cnt WHERE x<1000000000) SELECT SUM(x) FROM cnt',
        ]),
        /exceeded/,
      );
      assert.ok(ticks > 5, 'The parent event loop remained responsive while SQLite ran');
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(
        sqliteQueries(uri, { ...o, signal: controller.signal }, ['SELECT 1']),
        /cancelled/,
      );
    } finally {
      clearInterval(timer);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

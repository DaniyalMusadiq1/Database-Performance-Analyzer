import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import initSqlJs from 'sql.js';
import { sqliteQueries } from '../src/sqlite';
import { collect, explain } from '../src/adapters';
import { createServer, Socket } from 'node:net';
export async function run() {
  const extension = vscode.extensions.getExtension('DaniyalMusadiq.database-performance-analyzer');
  assert.ok(extension, 'Extension manifest registered');
  const api = await extension.activate();
  assert.ok(extension.isActive);
  const commands = await vscode.commands.getCommands(true);
  for (const c of [
    'dbPerf.open',
    'dbPerf.detect',
    'dbPerf.explain',
    'dbPerf.demo',
    'dbPerf.manage',
  ])
    assert.ok(commands.includes(c), `${c} registered`);
  await vscode.commands.executeCommand('dbPerf.connections.focus');
  await vscode.commands.executeCommand('dbPerf.open');
  assert.ok(api.hasDashboard(), 'Dashboard opens directly from its sidebar command');
  await vscode.commands.executeCommand('dbPerf.demo');
  assert.ok(api.hasDashboard(), 'Demo dashboard created');
  assert.equal(typeof api.profileCount(), 'number');
  const directory = await mkdtemp(join(tmpdir(), 'dbperf-host-'));
  try {
    const wasmPath = join(extension.extensionPath, 'dist', 'sql-wasm.wasm'),
      SQL = await initSqlJs({ locateFile: () => wasmPath }),
      db = new SQL.Database();
    db.run('CREATE TABLE host_fixture(id INTEGER);INSERT INTO host_fixture VALUES(1)');
    const path = join(directory, 'host.sqlite');
    await writeFile(path, Buffer.from(db.export()));
    db.close();
    const rows = await sqliteQueries(
      pathToFileURL(path).toString(),
      {
        timeoutMs: 4000,
        slowQueryMs: 100,
        wasmPath,
        sqliteWorkerPath: join(extension.extensionPath, 'dist', 'sqlite-worker.js'),
      },
      ['SELECT COUNT(*) AS count FROM host_fixture'],
    );
    assert.equal(rows[0][0].count, 1, 'Bundled SQLite worker and WASM function inside VS Code');
    const options = {
      timeoutMs: 4000,
      slowQueryMs: 100,
      wasmPath,
      sqliteWorkerPath: join(extension.extensionPath, 'dist', 'sqlite-worker.js'),
    };
    const profile = {
      id: 'host-test',
      name: 'Host test',
      engine: 'sqlite' as const,
      target: 'Local SQLite file',
      tls: false,
      createdAt: '',
    };
    const snapshot = await collect(profile, pathToFileURL(path).toString(), options);
    assert.ok(snapshot.tables.some((t) => t.name === 'host_fixture'));
    const plan = await explain(
      profile,
      pathToFileURL(path).toString(),
      'SELECT * FROM host_fixture',
      false,
      options,
    );
    assert.ok(plan.nodes.length > 0);
    if (Number(process.versions.node.split('.')[0]) < 20) {
      for (const engine of ['mongodb', 'redis', 'sqlserver'] as const)
        await assert.rejects(
          collect({ ...profile, engine }, `${engine}://localhost/database`, options),
          /Update VS Code/,
        );
    }
    for (const engine of ['postgres', 'mysql'] as const) {
      const sockets = new Set<Socket>();
      let reached = false;
      const server = createServer((socket) => {
        reached = true;
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const address = server.address();
        assert.ok(address && typeof address !== 'string');
        await assert.rejects(
          collect({ ...profile, engine }, `${engine}://test:test@127.0.0.1:${address.port}/test`, {
            ...options,
            timeoutMs: 300,
          }),
        );
        assert.ok(reached, `${engine} driver reached a test endpoint in this runtime`);
      } finally {
        sockets.forEach((socket) => socket.destroy());
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
    console.log(
      `Verified VS Code ${vscode.version}, Node ${process.versions.node}, SQLite collection/plan and PostgreSQL/MySQL connection timeouts.`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  console.log(
    'Extension host: activation, command registration demo dashboard and bundled SQLite worker passed.',
  );
}

import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import initSqlJs from 'sql.js';
import { sqliteQueries } from '../src/sqlite';
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
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  console.log(
    'Extension host: activation, command registration demo dashboard and bundled SQLite worker passed.',
  );
}

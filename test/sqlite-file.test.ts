import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSqliteBackup } from '../src/sqlite-file';
test('SQLite reader checks format, bounded size and rollback-journal safety', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dbperf-file-'));
  try {
    const path = join(dir, 'test.sqlite'),
      bytes = Buffer.alloc(4096);
    await writeFile(path, bytes);
    await assert.rejects(readSqliteBackup(path), /not a valid SQLite/);
    bytes.write('SQLite format 3\0');
    await writeFile(path, bytes);
    assert.deepEqual(await readSqliteBackup(path), bytes);
    await assert.rejects(readSqliteBackup(path, 1024), /regular files/);
    await writeFile(path + '-journal', 'active');
    await assert.rejects(readSqliteBackup(path), /rollback journal/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

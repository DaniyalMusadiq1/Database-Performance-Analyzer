import { open, stat } from 'node:fs/promises';
async function noSidecars(path: string) {
  for (const suffix of ['-wal', '-journal']) {
    try {
      if ((await stat(path + suffix)).size > 0)
        throw new Error(
          `This SQLite database has an active ${suffix === '-wal' ? 'WAL' : 'rollback journal'}. Create a consistent SQLite backup before inspecting it.`,
        );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
}
export async function readSqliteBackup(
  path: string,
  maxBytes = 256 * 1024 * 1024,
): Promise<Buffer> {
  await noSidecars(path);
  const handle = await open(path, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maxBytes)
      throw new Error(
        'SQLite inspection supports regular files up to 256 MB. Use a consistent backup.',
      );
    if (before.size < 100) throw new Error('The file is not a valid SQLite database.');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        Math.min(1024 * 1024, bytes.length - offset),
        offset,
      );
      if (!bytesRead)
        throw new Error('SQLite file changed while reading. Inspect a consistent backup.');
      offset += bytesRead;
    }
    const after = await handle.stat(),
      current = await stat(path);
    await noSidecars(path);
    if (
      [after, current].some(
        (v) =>
          v.size !== before.size ||
          v.mtimeMs !== before.mtimeMs ||
          v.ctimeMs !== before.ctimeMs ||
          v.ino !== before.ino ||
          v.dev !== before.dev,
      )
    )
      throw new Error('SQLite file changed while reading. Inspect a consistent backup.');
    if (bytes.subarray(0, 16).toString('binary') !== 'SQLite format 3\0')
      throw new Error('The file is not a valid SQLite database.');
    return bytes;
  } finally {
    await handle.close();
  }
}

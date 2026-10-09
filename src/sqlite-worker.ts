import { parentPort, workerData } from 'node:worker_threads';
import initSqlJs from 'sql.js';
import { readSqliteBackup } from './sqlite-file';
async function run() {
  const { path, wasmPath, queries } = workerData as {
    path: string;
    wasmPath: string;
    queries: string[];
  };
  const bytes = await readSqliteBackup(path);
  const SQL = await initSqlJs({ locateFile: () => wasmPath });
  const db = new SQL.Database(bytes);
  try {
    db.run('PRAGMA query_only=ON');
    const results = queries.map((sql) =>
      db
        .exec(sql)
        .flatMap((r) =>
          r.values.map((v) => Object.fromEntries(r.columns.map((c, i) => [c, v[i]]))),
        ),
    );
    parentPort!.postMessage({ results });
  } finally {
    db.close();
  }
}
void run().catch((error) =>
  parentPort!.postMessage({
    error: error instanceof Error ? error.message : 'SQLite inspection failed.',
  }),
);

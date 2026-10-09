import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { deadline, throwIfAborted } from './lifecycle';
import { Options } from './types';
export async function sqliteQueries(
  uri: string,
  o: Options,
  queries: string[],
): Promise<Record<string, any>[][]> {
  throwIfAborted(o.signal);
  let worker: Worker | undefined;
  try {
    return await deadline(
      o,
      async (signal) => {
        worker = new Worker(o.sqliteWorkerPath ?? join(__dirname, 'sqlite-worker.js'), {
          workerData: {
            path: fileURLToPath(uri.replace(/^sqlite:/, 'file:')),
            wasmPath: o.wasmPath,
            queries,
          },
          execArgv: [],
          resourceLimits: { maxOldGenerationSizeMb: 384 },
        });
        throwIfAborted(signal);
        const w = worker;
        return new Promise((resolve, reject) => {
          let received = false;
          w.once('message', (m) => {
            received = true;
            if (m.error) reject(new Error(String(m.error)));
            else resolve(m.results);
          });
          w.once('error', reject);
          w.once('exit', (code) => {
            if (!received)
              reject(new Error(`SQLite worker stopped before producing a result (code ${code}).`));
          });
        });
      },
      () => {
        void worker?.terminate();
      },
    );
  } finally {
    await worker?.terminate();
  }
}

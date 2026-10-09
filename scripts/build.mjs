import { build } from 'esbuild';
import { hardenFormat } from './harden-format.mjs';
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
const result = await build({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  target: 'node16.14',
  format: 'cjs',
  external: ['vscode', 'pg-native', 'cloudflare:sockets'],
  sourcemap: false,
  minify: true,
  logLevel: 'info',
  metafile: true,
  plugins: [
    {
      name: 'bound-sprintf',
      setup(b) {
        b.onLoad({ filter: /sprintf-js[\\/]src[\\/]sprintf\.js$/ }, async ({ path }) => ({
          contents: hardenFormat(await readFile(path, 'utf8')),
          loader: 'js',
        }));
      },
    },
  ],
});
const worker = await build({
  entryPoints: ['src/sqlite-worker.ts'],
  bundle: true,
  outfile: 'dist/sqlite-worker.js',
  platform: 'node',
  target: 'node16.14',
  format: 'cjs',
  minify: true,
  metafile: true,
});
Object.assign(result.metafile.inputs, worker.metafile.inputs);
await copyFile('node_modules/sql.js/dist/sql-wasm.wasm', 'dist/sql-wasm.wasm');

await writeFile('dist/build-meta.json', JSON.stringify(result.metafile));

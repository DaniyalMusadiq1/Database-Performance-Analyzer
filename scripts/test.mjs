import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const directory = process.argv.includes('--integration') ? 'test/integration' : 'test';
for (const file of (await readdir(directory)).filter((f) => /\.test\.(ts|mjs)$/.test(f)).sort())
  await import(pathToFileURL(resolve(directory, file)).href);

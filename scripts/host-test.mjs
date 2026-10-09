import { runTests } from '@vscode/test-electron';
import { build } from 'esbuild';
import { resolve } from 'node:path';
await build({
  entryPoints: ['test/host.ts'],
  bundle: true,
  outfile: 'out/host.cjs',
  platform: 'node',
  format: 'cjs',
  external: ['vscode'],
  target: 'node20',
});
await runTests({
  ...(process.env.DBPERF_VSCODE_EXECUTABLE
    ? { vscodeExecutablePath: process.env.DBPERF_VSCODE_EXECUTABLE }
    : {}),
  extensionDevelopmentPath: resolve('.'),
  extensionTestsPath: resolve('out/host.cjs'),
  launchArgs: [
    '--no-sandbox',
    '--disable-gpu',
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-extensions',
  ],
});

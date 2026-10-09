import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const p = JSON.parse(await readFile('package.json', 'utf8'));
if (p.publisher === 'local-database-tools') {
  console.error(
    'Set package.json publisher to your registered Marketplace publisher ID first. See PUBLISHING.md.',
  );
  process.exit(1);
}
const result = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['vsce', 'publish', '--no-dependencies', '--allow-missing-repository', ...process.argv.slice(2)],
  { stdio: 'inherit', shell: false },
);
process.exit(result.status ?? 1);

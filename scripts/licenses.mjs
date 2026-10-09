import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
const meta = JSON.parse(await readFile('dist/build-meta.json', 'utf8'));
const roots = new Set();
for (const path of Object.keys(meta.inputs)) {
  const match = path.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)/);
  if (match) roots.add(match[1]);
}
let notices =
  '# Bundled dependency notices\n\nGenerated from the modules present in the esbuild output. The extension itself is MIT licensed.\n\n';
for (const root of [...roots].sort()) {
  try {
    const p = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    notices += `## ${p.name} ${p.version}\n\nLicense: ${p.license ?? 'See package license'}\n\n`;
    let found = false;
    for (const file of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'license.md', 'COPYING'])
      try {
        const text = await readFile(join(root, file), 'utf8');
        notices += '```text\n' + text + '\n```\n\n';
        found = true;
        break;
      } catch {}
    if (!found) {
      notices += `Original package: https://www.npmjs.com/package/${p.name}\n\n`;
    }
  } catch {}
}
await writeFile('THIRD_PARTY_NOTICES.md', notices);

// Bundled mitigation for GHSA-hp3w-g68c-fv3c; keep the original BSD license.
export function hardenFormat(source) {
  const marker = 'else if ((match = re.placeholder.exec(_fmt)) !== null) {';
  if (!source.includes(marker))
    throw new Error('sprintf-js source changed; re-review the formatting bounds before packaging.');
  return source.replace(
    marker,
    marker +
      "\n                if (Number(match[6] || 0) > 10000 || Number(match[7] || 0) > 10000) { throw new RangeError('[sprintf] Width/precision exceeds safe bounds'); }",
  );
}

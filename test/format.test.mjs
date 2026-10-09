import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { hardenFormat } from '../scripts/harden-format.mjs';
test('Bundled formatter rejects unbounded precision and width and preserves driver formatting', async () => {
  const source = hardenFormat(await readFile('node_modules/sprintf-js/src/sprintf.js', 'utf8'));
  const module = { exports: {} };
  vm.runInNewContext(source, { exports: module.exports, module });
  const { sprintf } = module.exports;
  assert.equal(sprintf('Type 0x%02X: %s', 15, 'ok'), 'Type 0x0F: ok');
  assert.throws(() => sprintf('%999999999s', 'x'), /safe bounds/);
  assert.throws(() => sprintf('%.999999999f', 1), /safe bounds/);
  assert.throws(() => hardenFormat('unrecognized source'), /source changed/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { settingNumber } from '../src/settings';
test('Malformed settings cannot create zero-delay monitoring or unbounded history', () => {
  for (const invalid of [NaN, Infinity, -Infinity, '0', null, {}])
    assert.equal(settingNumber(invalid, 30, 5, 300, true), 30);
  assert.equal(settingNumber(0, 30, 5, 300, true), 5);
  assert.equal(settingNumber(10000, 30, 5, 300, true), 300);
  assert.equal(settingNumber(5.8, 30, 5, 300, true), 5);
});

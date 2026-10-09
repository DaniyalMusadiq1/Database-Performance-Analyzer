import test from 'node:test';
import assert from 'node:assert/strict';
import { SnapshotHistory, chartHistory } from '../src/history';
import { demoSnapshot } from '../src/demo';
test('History enforces per-connection sample limits and recent-connection limits', () => {
  const h = new SnapshotHistory(1000000, 2);
  for (let i = 0; i < 5; i++) h.add('a', demoSnapshot(), 2);
  assert.equal(h.get('a').length, 2);
  h.add('b', demoSnapshot(), 2);
  h.add('c', demoSnapshot(), 2);
  assert.equal(h.get('a').length, 0);
  assert.equal(h.get('b').length, 1);
  assert.equal(h.get('c').length, 1);
});
test('History has a global byte budget, even for an oversized individual snapshot', () => {
  const s = demoSnapshot(),
    size = Buffer.byteLength(JSON.stringify(s)),
    h = new SnapshotHistory(size * 2 + 1);
  h.add('a', s, 10);
  h.add('a', s, 10);
  h.add('b', s, 10);
  assert.ok(h.retainedBytes <= size * 2 + 1);
  assert.equal(h.get('a').length, 1);
  h.clear();
  assert.equal(h.retainedBytes, 0);
  const tiny = new SnapshotHistory(1);
  assert.deepEqual(tiny.add('a', s, 5), []);
  assert.equal(tiny.retainedBytes, 0);
});
test('Chart messages contain metrics but do not duplicate query/session text', () => {
  const points = chartHistory([demoSnapshot()]);
  assert.deepEqual(Object.keys(points[0]), ['timestamp', 'metrics']);
  assert.ok(!JSON.stringify(points).includes('SELECT customer_id'));
});

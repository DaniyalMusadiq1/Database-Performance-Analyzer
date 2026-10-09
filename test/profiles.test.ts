import test from 'node:test';
import assert from 'node:assert/strict';
import { loadProfiles, SerialQueue } from '../src/profiles';
test('Corrupted profile state cannot break activation or inject an unsupported engine', () => {
  assert.deepEqual(loadProfiles({ oops: true }), []);
  const p = {
    id: 'valid-id',
    name: 'Local',
    engine: 'postgres',
    target: 'localhost/app',
    tls: true,
    createdAt: '',
  };
  assert.deepEqual(
    loadProfiles([null, {}, p, p, { ...p, id: 'bad', engine: 'bogus' }, { ...p, id: 'demo' }]),
    [p],
  );
});
test('Storage changes serialize and a rejected change does not block the next save', async () => {
  const q = new SerialQueue(),
    log: string[] = [];
  let release: () => void = () => {};
  const barrier = new Promise<void>((r) => {
    release = r;
  });
  const first = q.run(async () => {
    log.push('first');
    await barrier;
    log.push('first done');
  });
  const second = q.run(async () => {
    log.push('second');
    throw new Error('write failed');
  });
  const third = q.run(async () => {
    log.push('third');
    return 42;
  });
  const failed = assert.rejects(second, /write failed/);
  await Promise.resolve();
  release();
  await first;
  await failed;
  assert.equal(await third, 42);
  assert.deepEqual(log, ['first', 'first done', 'second', 'third']);
});

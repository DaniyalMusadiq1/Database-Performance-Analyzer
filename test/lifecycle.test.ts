import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deadline,
  acquireResource,
  CancelledError,
  TimeoutError,
  isInterrupted,
} from '../src/lifecycle';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
test('A pre-cancelled operation never starts work', async () => {
  const c = new AbortController();
  c.abort();
  let ran = false;
  await assert.rejects(
    deadline(
      { timeoutMs: 100, signal: c.signal },
      async () => {
        ran = true;
        return 1;
      },
      () => {},
    ),
    CancelledError,
  );
  assert.equal(ran, false);
});
test('Cancellation during startup is observed and disposal runs once', async () => {
  const c = new AbortController();
  let closed = 0;
  await assert.rejects(
    deadline(
      { timeoutMs: 100, signal: c.signal },
      async () => {
        c.abort();
        await wait(10);
        return 1;
      },
      () => {
        closed++;
      },
    ),
    CancelledError,
  );
  assert.equal(closed, 1);
});
test('Timeout propagates to work and cleanup exceptions cannot replace it', async () => {
  let signal: AbortSignal | undefined;
  await assert.rejects(
    deadline(
      { timeoutMs: 10 },
      async (s) => {
        signal = s;
        await wait(40);
        return 1;
      },
      () => {
        throw new Error('cleanup failed');
      },
    ),
    TimeoutError,
  );
  assert.equal(signal?.aborted, true);
});
test('Late acquired resources are disposed before use after timeout', async () => {
  let disposed = 0,
    used = false;
  await assert.rejects(
    deadline(
      { timeoutMs: 10 },
      async (signal) => {
        const value = await acquireResource(
          signal,
          async () => {
            await wait(30);
            return { id: 1 };
          },
          () => {
            disposed++;
          },
        );
        used = !!value;
        return value;
      },
      () => {},
    ),
    TimeoutError,
  );
  await wait(50);
  assert.equal(disposed, 1);
  assert.equal(used, false);
});
test('Successful operations remove their cancellation handler', async () => {
  const c = new AbortController();
  let closed = 0;
  assert.equal(
    await deadline(
      { timeoutMs: 100, signal: c.signal },
      async () => 42,
      () => {
        closed++;
      },
    ),
    42,
  );
  c.abort();
  await wait(1);
  assert.equal(closed, 0);
});
test('Driver cancellation and timeout codes are fatal; permission errors remain optional', () => {
  for (const code of [
    '57014',
    'ETIMEOUT',
    'ECANCEL',
    'PROTOCOL_SEQUENCE_TIMEOUT',
    50,
    'ECONNRESET',
  ])
    assert.equal(isInterrupted({ code }), true);
  assert.equal(isInterrupted({ code: '42501' }), false);
  assert.equal(isInterrupted(new Error('Query read timeout')), true);
});

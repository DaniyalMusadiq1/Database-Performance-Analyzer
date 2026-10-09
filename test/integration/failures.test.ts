import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, Socket } from 'node:net';
import { AddressInfo } from 'node:net';
import { collect } from '../../src/adapters';
import { Profile, Engine } from '../../src/types';
import { isInterrupted } from '../../src/lifecycle';
const enabled = process.env.DBPERF_TEST_FAILURES === '1';
for (const [engine, scheme] of [
  ['postgres', 'postgresql'],
  ['mysql', 'mysql'],
  ['sqlserver', 'sqlserver'],
  ['mongodb', 'mongodb'],
  ['redis', 'redis'],
] as const) {
  for (const mode of ['timeout', 'cancel'] as const)
    test(
      `${engine}: ${mode} closes a stalled connection`,
      { skip: !enabled, timeout: 8000 },
      async () => {
        const sockets = new Set<Socket>();
        const server = createServer((socket) => {
          sockets.add(socket);
          socket.on('data', () => {});
          socket.on('error', () => {});
          socket.on('close', () => sockets.delete(socket));
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = (server.address() as AddressInfo).port;
        const p: Profile = {
          id: 'failure',
          name: 'Failure fixture',
          engine: engine as Engine,
          target: 'local',
          tls: false,
          createdAt: '',
        };
        const uri = `${scheme}://test:test@127.0.0.1:${port}/${engine === 'redis' ? '0' : 'test'}`;
        const controller = new AbortController();
        let timer: NodeJS.Timeout | undefined;
        try {
          if (mode === 'cancel') timer = setTimeout(() => controller.abort(), 30);
          const started = Date.now();
          await assert.rejects(
            collect(p, uri, {
              timeoutMs: 250,
              slowQueryMs: 100,
              wasmPath: 'unused',
              signal: controller.signal,
            }),
            (error) =>
              isInterrupted(error) ||
              (mode === 'timeout' &&
                error instanceof Error &&
                /timeout|timed? ?out|exceeded/i.test(error.message)),
          );
          assert.ok(
            Date.now() - started < 4000,
            'Operation stayed within its bounded collection deadline',
          );
          const until = Date.now() + 1500;
          while (sockets.size && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
          assert.equal(sockets.size, 0, 'No connected socket leaked after failure');
        } finally {
          clearTimeout(timer);
          for (const socket of sockets) socket.destroy();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      },
    );
}

test(
  'Redis Verified TLS starts a TLS handshake even when input uses redis://',
  { skip: !enabled, timeout: 8000 },
  async () => {
    let firstByte: number | undefined;
    const c = new AbortController();
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on('data', (data) => {
        firstByte ??= typeof data === 'string' ? data.charCodeAt(0) : data[0];
        c.abort();
      });
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const p: Profile = {
      id: 'tls',
      name: 'TLS fixture',
      engine: 'redis',
      target: 'local',
      tls: true,
      createdAt: '',
    };
    const timer = setTimeout(() => c.abort(), 1500);
    try {
      await assert.rejects(
        collect(p, `redis://127.0.0.1:${port}/0`, {
          timeoutMs: 2000,
          slowQueryMs: 100,
          wasmPath: 'unused',
          signal: c.signal,
        }),
        isInterrupted,
      );
      assert.equal(firstByte, 22, 'TLS ClientHello was sent, rather than plaintext Redis commands');
    } finally {
      clearTimeout(timer);
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    }
  },
);

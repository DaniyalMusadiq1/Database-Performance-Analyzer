import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { collect, explain } from '../../src/adapters';
import { Engine, Profile, Options } from '../../src/types';
const o: Options = { timeoutMs: 8000, slowQueryMs: 100, wasmPath: resolve('dist/sql-wasm.wasm') };
for (const [engine, key] of [
  ['postgres', 'POSTGRES'],
  ['mysql', 'MYSQL'],
  ['sqlserver', 'SQLSERVER'],
  ['mongodb', 'MONGODB'],
  ['redis', 'REDIS'],
] as const) {
  const uri = process.env['DBPERF_TEST_' + key + '_URL'];
  test(
    `${engine}: live collection${['postgres', 'mysql', 'sqlserver'].includes(engine) ? ' and estimated plan' : ''}`,
    { skip: !uri },
    async () => {
      const p: Profile = {
        id: 'test',
        name: 'Test ' + engine,
        engine: engine as Engine,
        target: 'test',
        tls: false,
        createdAt: '',
      };
      const s = await collect(p, uri!, o);
      assert.ok(s.metrics.length > 0);
      assert.equal(s.engine, engine);
      assert.ok(Number.isFinite(Date.parse(s.timestamp)));
      if (['postgres', 'mysql', 'sqlserver'].includes(engine)) {
        const plan = await explain(p, uri!, 'SELECT 1 AS value', false, o);
        assert.ok(plan.nodes.length > 0);
        assert.equal(plan.executed, false);
      }
      if (engine === 'postgres') {
        if (process.env.DBPERF_TEST_PG_STATEMENTS === '1') {
          assert.ok(s.capabilities.includes('queries'));
          assert.ok(s.queryStatsReset);
          assert.ok(s.serverIdentity);
          assert.ok(s.tables.some((t) => t.name === 'public.dbperf_test'));
        }
        const plan = await explain(p, uri!, 'SELECT 1 AS value', true, o);
        assert.equal(plan.executed, true);
        assert.ok(JSON.stringify(plan.raw).includes('Actual Total Time'));
        await assert.rejects(explain(p, uri!, 'DELETE FROM dbperf_test', false, o), /SELECT/);
      }
    },
  );
}

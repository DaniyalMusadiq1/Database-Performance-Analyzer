import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeIssue } from '../src/compatibility';
test('Old editor runtimes support core engines and clearly gate modern drivers', () => {
  for (const engine of ['demo', 'postgres', 'mysql', 'sqlite'] as const)
    assert.equal(runtimeIssue(engine, '16.14.2'), undefined);
  for (const engine of ['mongodb', 'redis', 'sqlserver'] as const)
    assert.match(runtimeIssue(engine, '16.14.2')!, /Update VS Code/);
  assert.ok(runtimeIssue('mongodb', '20.18.0'));
  assert.equal(runtimeIssue('mongodb', '20.19.0'), undefined);
  assert.equal(runtimeIssue('redis', '20.0.0'), undefined);
  assert.ok(runtimeIssue('sqlserver', '20.19.0'));
  for (const engine of ['mongodb', 'redis', 'sqlserver'] as const)
    assert.equal(runtimeIssue(engine, '22.0.0'), undefined);
});

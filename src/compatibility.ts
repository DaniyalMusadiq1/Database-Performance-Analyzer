import { Engine } from './types';
const minimumNode: Partial<Record<Engine, [number, number]>> = {
  mongodb: [20, 19],
  redis: [20, 0],
  sqlserver: [22, 0],
};
export function runtimeIssue(
  engine: Engine,
  nodeVersion = process.versions.node,
): string | undefined {
  const required = minimumNode[engine];
  if (!required) return;
  const [major, minor] = nodeVersion.split('.').map(Number);
  if (major > required[0] || (major === required[0] && minor >= required[1])) return;
  return `${engine} needs Node ${required.join('.')} or newer in the VS Code extension host. Update VS Code to 1.101 or newer to use all engines. On VS Code 1.71.2, use PostgreSQL, MySQL/MariaDB, SQLite or the demo.`;
}
export function requireRuntime(engine: Engine): void {
  const issue = runtimeIssue(engine);
  if (issue) throw new Error(issue);
}

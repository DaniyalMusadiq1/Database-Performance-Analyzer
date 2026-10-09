export type Engine = 'postgres' | 'mysql' | 'sqlserver' | 'sqlite' | 'mongodb' | 'redis' | 'demo';
export interface Profile {
  id: string;
  name: string;
  engine: Engine;
  target: string;
  tls: boolean;
  createdAt: string;
}
export interface Metric {
  label: string;
  value: number | string;
  unit?: string;
  description: string;
}
export interface QueryStat {
  id: string;
  query: string;
  calls: number;
  totalMs: number;
  meanMs: number;
  rows: number;
}
export interface Session {
  id: string;
  user: string;
  state: string;
  ageSeconds: number;
  wait: string;
  query: string;
  blockers: string[];
}
export interface TableStat {
  name: string;
  rows: number;
  sizeBytes: number;
  scans: number;
  indexScans: number;
  deadRows: number;
  extra?: string;
}
export interface IndexStat {
  name: string;
  table: string;
  scans: number;
  sizeBytes: number;
  definition: string;
}
export interface Finding {
  severity: 'info' | 'warning' | 'critical';
  title: string;
  detail: string;
  action: string;
}
export interface Snapshot {
  engine: Engine;
  connection: string;
  timestamp: string;
  uptimeSeconds?: number;
  queryStatsReset?: string;
  serverIdentity?: string;
  queryMode?: 'cumulative' | 'samples';
  metrics: Metric[];
  queries: QueryStat[];
  sessions: Session[];
  tables: TableStat[];
  indexes: IndexStat[];
  findings: Finding[];
  capabilities: string[];
  notices: string[];
}
export interface PlanNode {
  name: string;
  rows?: number;
  cost?: number;
  actualMs?: number;
  detail?: string;
  children: PlanNode[];
}
export interface Plan {
  engine: Engine;
  sql: string;
  executed: boolean;
  raw: unknown;
  nodes: PlanNode[];
  findings: Finding[];
  elapsedMs: number;
}
export interface Detected {
  engine: Exclude<Engine, 'demo'>;
  uri: string;
  source: string;
  target: string;
}
export interface Discovery {
  connections: Detected[];
  frameworks: string[];
  models: { name: string; source: string }[];
  notices: string[];
}
export interface Options {
  timeoutMs: number;
  slowQueryMs: number;
  wasmPath: string;
  signal?: AbortSignal;
  sqliteWorkerPath?: string;
}

import { Engine } from './types';
import { validateUri } from './security';
export type NetworkEngine = Exclude<Engine, 'demo' | 'sqlite'>;
export const connectionDefaults: Record<
  NetworkEngine,
  { scheme: string; port: number; database: string }
> = {
  postgres: { scheme: 'postgresql', port: 5432, database: 'postgres' },
  mysql: { scheme: 'mysql', port: 3306, database: '' },
  sqlserver: { scheme: 'sqlserver', port: 1433, database: 'master' },
  mongodb: { scheme: 'mongodb', port: 27017, database: 'admin' },
  redis: { scheme: 'redis', port: 6379, database: '0' },
};
export function buildConnectionUri(
  engine: NetworkEngine,
  host: string,
  port: string,
  database: string,
  user: string,
  password: string,
): string {
  host = host.trim();
  if (!host || /[\s/@?#]/.test(host))
    throw new Error('Enter a hostname or IP address, without a URL or path.');
  const bare = host.replace(/^\[|\]$/g, '');
  if (bare.includes(':') && !/^[a-f\d:]+$/i.test(bare))
    throw new Error('Enter the port separately from the hostname.');
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
    throw new Error('Port must be between 1 and 65535.');
  if (engine === 'redis' && !/^\d+$/.test(database))
    throw new Error('Redis database must be a nonnegative integer.');
  if (!user && password && engine !== 'redis')
    throw new Error('Enter a username when providing a password.');
  const credentials =
    user || password ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}@` : '';
  const uri = `${connectionDefaults[engine].scheme}://${credentials}${bare.includes(':') ? '[' + bare + ']' : bare}:${Number(port)}/${encodeURIComponent(database)}`;
  validateUri(uri, engine);
  return uri;
}
/** Guided editing preserves URL options and secure Redis schemes; cluster/SRV URLs use the URL editor. */
export function connectionFields(uri: string) {
  const engine = detectNetworkEngine(uri);
  if (engine === 'mongodb' && /,/.test(uri.split('?')[0]))
    throw new Error('Use Update connection URL for a multiple-host MongoDB cluster.');
  const url = new URL(uri);
  if (url.protocol === 'mongodb+srv:' || url.hostname.includes(','))
    throw new Error(
      'Use Update connection URL for MongoDB SRV or multiple hosts so cluster options are preserved.',
    );
  return {
    engine,
    host: url.hostname,
    port: url.port || String(connectionDefaults[engine].port),
    database: decodeURIComponent(url.pathname.slice(1)),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}
function detectNetworkEngine(uri: string): NetworkEngine {
  const scheme = new URL(uri).protocol;
  const engine =
    scheme === 'postgres:' || scheme === 'postgresql:'
      ? 'postgres'
      : scheme === 'mysql:' || scheme === 'mariadb:'
        ? 'mysql'
        : scheme === 'mssql:' || scheme === 'sqlserver:'
          ? 'sqlserver'
          : scheme === 'mongodb:' || scheme === 'mongodb+srv:'
            ? 'mongodb'
            : scheme === 'redis:' || scheme === 'rediss:'
              ? 'redis'
              : undefined;
  if (!engine) throw new Error('This is a file connection; use the file picker instead.');
  return engine;
}
export function preserveConnectionOptions(original: string, updated: string): string {
  const old = new URL(original),
    next = new URL(updated);
  next.search = old.search;
  if (old.protocol === 'rediss:') next.protocol = 'rediss:';
  validateUri(next.toString());
  return next.toString();
}

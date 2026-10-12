import { Engine } from './types';
import { detectEngine, redactError, validateUri } from './security';
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

/** Remote hosts use verified encryption by default; only loopback defaults to plaintext. */
export function defaultConnectionTls(uri: string): boolean {
  if (detectEngine(uri) === 'sqlite') return false;
  if (/^(rediss|mongodb\+srv):/i.test(uri)) return true;
  try {
    const url = new URL(uri);
    if (
      [...url.searchParams].some(
        ([key, value]) =>
          /^(sslmode|ssl|tls)$/i.test(key) &&
          /^(require|verify-ca|verify-full|true|1)$/i.test(value),
      )
    )
      return true;
    return !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
  } catch {
    return true;
  }
}

/** Add practical next steps after credentials have been removed from driver errors. */
export function connectionFailure(error: unknown, uri: string): string {
  const message = redactError(error, uri);
  let action = 'Check the database name and connection details, then try again.';
  if (/password|authentication|login failed|access denied|NOAUTH|WRONGPASS|28P01/i.test(message))
    action = 'Check your username and password. Use the account provided by your database service.';
  else if (/certificate|self.signed|TLS|SSL/i.test(message))
    action =
      'Check Connection security and the server certificate. Remote servers need a trusted certificate.';
  else if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message))
    action = 'Check the server address and your internet or VPN connection.';
  else if (/ECONNREFUSED/i.test(message))
    action =
      'Start your database service and check the server and port. In SSH or containers, localhost refers to the workspace host.';
  else if (/timeout|timed out|ETIMEDOUT/i.test(message))
    action =
      'Check that the database is reachable, your VPN is connected and the firewall allows this port.';
  return message + '\n' + action;
}

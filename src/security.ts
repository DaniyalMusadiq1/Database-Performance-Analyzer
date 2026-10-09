import { Parser } from 'node-sql-parser';
import { Engine } from './types';
const parser = new Parser();
export function detectEngine(uri: string): Exclude<Engine, 'demo'> {
  const scheme = uri.split(':')[0].toLowerCase();
  const map: Record<string, Exclude<Engine, 'demo'>> = {
    postgres: 'postgres',
    postgresql: 'postgres',
    mysql: 'mysql',
    mariadb: 'mysql',
    sqlserver: 'sqlserver',
    mssql: 'sqlserver',
    sqlite: 'sqlite',
    file: 'sqlite',
    mongodb: 'mongodb',
    'mongodb+srv': 'mongodb',
    redis: 'redis',
    rediss: 'redis',
  };
  if (!map[scheme])
    throw new Error(
      'Unsupported URL. Use postgresql://, mysql://, sqlserver://, sqlite:///absolute/path, mongodb://, or redis://.',
    );
  return map[scheme];
}
export function targetOf(uri: string): string {
  if (/^(sqlite|file):/i.test(uri)) return 'Local SQLite file';
  try {
    const u = new URL(uri);
    return `${u.hostname}${u.port ? ':' + u.port : ''}${u.pathname === '/' ? '' : u.pathname}`;
  } catch {
    return uri
      .replace(/^[^:]+:\/\//, '')
      .replace(/^.*@/, '')
      .split('?')[0]
      .slice(0, 160);
  }
}
export function validateUri(uri: string, engine = detectEngine(uri)): void {
  if (!uri || uri.length > 8192 || /[\r\n\0]/.test(uri))
    throw new Error('Enter a valid connection URL.');
  if (uri.includes('#'))
    throw new Error(
      'URL fragments are not supported. Encode special characters in passwords and paths.',
    );
  if (engine === 'sqlite') {
    if (!/^(sqlite|file):\/\/\//.test(uri))
      throw new Error('Use sqlite:///absolute/path/to/database.sqlite.');
    const file = new URL(uri.replace(/^sqlite:/i, 'file:'));
    if (file.hostname && file.hostname !== 'localhost')
      throw new Error('SQLite needs a local file path on the workspace host.');
    if (file.search || file.hash || file.username || file.password)
      throw new Error('SQLite file URLs cannot include credentials or query parameters.');
    return;
  }
  if (engine === 'mongodb') {
    if (!/^mongodb(?:\+srv)?:\/\/[^/?\s]+/i.test(uri)) throw new Error('Invalid MongoDB URL.');
    const params = new URLSearchParams(uri.split('?')[1] ?? '');
    for (const [key, value] of params)
      if (
        ['tlsallowinvalidcertificates', 'tlsallowinvalidhostnames', 'tlsinsecure'].includes(
          key.toLowerCase(),
        ) &&
        value.toLowerCase() !== 'false'
      )
        throw new Error('Certificate verification cannot be disabled.');
    return;
  }
  const url = new URL(uri);
  if (url.hash)
    throw new Error('URL fragments are not supported. Encode special characters in passwords.');
  if (!url.hostname) throw new Error('The URL needs a hostname.');
  if (url.port && (Number(url.port) < 1 || Number(url.port) > 65535))
    throw new Error('Invalid port.');
  if (engine === 'redis' && !/^\/(?:\d+)?$/.test(url.pathname) && url.pathname !== '')
    throw new Error('Redis URLs need a numeric database index, such as /0.');
  if (engine === 'sqlserver' && url.search)
    throw new Error('SQL Server URL parameters are not supported. Choose TLS in the next step.');
}
export function redactError(error: unknown, uri?: string): string {
  let message = error instanceof Error ? error.message : String(error);
  if (uri) {
    message = message.split(uri).join('[connection]');
    const credentials = /:\/\/([^/@]+)@/.exec(uri)?.[1];
    if (credentials)
      for (const secret of credentials.split(':')) {
        if (secret) {
          message = message.split(secret).join('[redacted]');
          try {
            message = message.split(decodeURIComponent(secret)).join('[redacted]');
          } catch {}
        }
      }
    try {
      const u = new URL(uri);
      for (const secret of [u.password, u.username, ...u.searchParams.values()])
        if (secret) {
          message = message.split(secret).join('[redacted]');
          try {
            message = message.split(decodeURIComponent(secret)).join('[redacted]');
          } catch {}
        }
    } catch {}
  }
  return message
    .replace(
      /(?:postgres(?:ql)?|mysql|sqlserver|mssql|mongodb(?:\+srv)?|rediss?):\/\/[^\s]+/gi,
      '[connection]',
    )
    .slice(0, 800);
}
export function validateSql(sql: string, engine: Engine): string {
  const clean = sql.trim();
  if (!clean || clean.length > 100000)
    throw new Error('Select one SQL SELECT statement (maximum 100 KB).');
  const dialect =
    engine === 'postgres' || engine === 'demo'
      ? 'Postgresql'
      : engine === 'sqlserver'
        ? 'TransactSQL'
        : engine === 'sqlite'
          ? 'SQLite'
          : 'MySQL';
  if (/\/\*(?:!|M!)/i.test(clean)) throw new Error('Executable SQL comments are not supported.');
  const unsafeFunctions = new Set(
    'set_config nextval setval pg_sleep pg_terminate_backend pg_cancel_backend pg_read_file pg_read_binary_file pg_ls_dir dblink lo_import lo_export pg_advisory_lock pg_advisory_xact_lock load_file sleep benchmark sys_eval sys_exec xp_cmdshell openrowset openquery opendatasource'.split(
      ' ',
    ),
  );
  let ast: unknown;
  try {
    ast = parser.astify(clean, { database: dialect });
  } catch {
    throw new Error(
      'Only a single parsable SELECT statement is supported. Parameters must be replaced with representative literals.',
    );
  }
  const statements = Array.isArray(ast) ? ast : [ast];
  if (statements.length !== 1 || (statements[0] as { type?: string }).type !== 'select')
    throw new Error('Only one SELECT statement can be explained.');
  function walk(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    const v = value as Record<string, unknown>;
    if (v.type === 'function' || v.type === 'aggr_func') {
      const name =
        typeof v.name === 'string'
          ? v.name
          : (v.name as { name?: { value?: string }[] })?.name?.map((n) => n.value ?? '').join('.');
      if (name && unsafeFunctions.has(name.split('.').pop()!.toLowerCase()))
        throw new Error('This statement calls a function unsuitable for performance analysis.');
    }
    if (
      typeof v.type === 'string' &&
      [
        'insert',
        'update',
        'delete',
        'replace',
        'create',
        'drop',
        'alter',
        'call',
        'exec',
        'truncate',
      ].includes(v.type)
    )
      throw new Error('Data-changing statements are not allowed, including inside CTEs.');
    if (
      (v.into &&
        typeof v.into === 'object' &&
        ((v.into as Record<string, unknown>).position ||
          (v.into as Record<string, unknown>).expr)) ||
      v.locking_read ||
      v.for_update
    )
      throw new Error('SELECT INTO and locking clauses are not supported.');
    Object.values(v).forEach(walk);
  }
  walk(statements[0]);
  // Retain conservative clause guards alongside AST validation.
  if (/\b(into\s+(outfile|dumpfile)|for\s+(update|share)|lock\s+in\s+share\s+mode)\b/i.test(clean))
    throw new Error(
      'This statement includes a function or clause unsuitable for performance analysis.',
    );
  return clean.replace(/;\s*$/, '');
}
export function escapeHtml(value: unknown): string {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
export function csvCell(value: unknown): string {
  let s = String(value ?? '');
  if (/^[\s]*[=+@-]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

/** Redis requires its URL scheme and socket TLS setting to agree. */
export function redisTransportUri(uri: string, tls: boolean): string {
  const url = new URL(uri);
  url.protocol = tls || url.protocol === 'rediss:' ? 'rediss:' : 'redis:';
  return url.toString();
}
export function networkHostname(uri: string): string {
  return new URL(uri).hostname.replace(/^\[([^\]]+)\]$/, '$1');
}

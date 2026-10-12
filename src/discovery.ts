import { detectEngine, targetOf, validateUri } from './security';
import { buildConnectionUri, connectionDefaults, NetworkEngine } from './connection';
import { Discovery } from './types';
export function inspectFiles(files: { path: string; text: string }[]): Discovery {
  const result: Discovery = { connections: [], frameworks: [], models: [], notices: [] };
  const seen = new Set<string>();
  for (const file of files) {
    if (file.text.length > 1024 * 1024) continue;
    const urls: string[] =
      file.text.match(
        /(?:postgres(?:ql)?|mysql|mariadb|sqlserver|mssql|mongodb(?:\+srv)?|rediss?):\/\/[^\s"'`<>]+|(?:sqlite|file):\/\/\/[^\s"'`<>]+/gi,
      ) ?? [];
    // Laravel and other dotenv applications commonly use separate connection fields.
    if (/(?:^|\/)\.env(?:\.|$)/.test(file.path)) {
      const env: Record<string, string> = {};
      for (const match of file.text.matchAll(
        /^\s*(?:export\s+)?([A-Z_][A-Z_0-9]*)\s*=\s*(.*)$/gm,
      )) {
        let value = match[2].trim();
        if (/^['"]/.test(value)) {
          const end = value.indexOf(value[0], 1);
          if (end < 0) continue;
          value = value.slice(1, end);
        } else value = value.replace(/\s+#.*$/, '').trim();
        env[match[1]] = value;
      }
      const engines: Record<string, NetworkEngine> = {
        pgsql: 'postgres',
        postgres: 'postgres',
        postgresql: 'postgres',
        mysql: 'mysql',
        mariadb: 'mysql',
        sqlsrv: 'sqlserver',
        sqlserver: 'sqlserver',
        mongodb: 'mongodb',
        redis: 'redis',
      };
      const configs: {
        engine: NetworkEngine;
        host: string;
        port?: string;
        database?: string;
        user?: string;
        password?: string;
      }[] = [];
      const engine = engines[env.DB_CONNECTION || env.DB_ENGINE || ''];
      if (engine && env.DB_HOST)
        configs.push({
          engine,
          host: env.DB_HOST,
          port: env.DB_PORT,
          database: env.DB_DATABASE,
          user: env.DB_USERNAME || env.DB_USER,
          password: env.DB_PASSWORD,
        });
      if (env.PGHOST)
        configs.push({
          engine: 'postgres',
          host: env.PGHOST,
          port: env.PGPORT,
          database: env.PGDATABASE,
          user: env.PGUSER,
          password: env.PGPASSWORD,
        });
      if (env.MYSQL_HOST)
        configs.push({
          engine: 'mysql',
          host: env.MYSQL_HOST,
          port: env.MYSQL_PORT,
          database: env.MYSQL_DATABASE,
          user: env.MYSQL_USER,
          password: env.MYSQL_PASSWORD,
        });
      if (env.REDIS_HOST)
        configs.push({
          engine: 'redis',
          host: env.REDIS_HOST,
          port: env.REDIS_PORT,
          database: env.REDIS_DB,
          user: env.REDIS_USERNAME,
          password: env.REDIS_PASSWORD,
        });
      for (const config of configs) {
        const values = [
          config.host,
          config.port || String(connectionDefaults[config.engine].port),
          config.database || connectionDefaults[config.engine].database,
          config.user || '',
          config.password || '',
        ];
        if (values.some((value) => /\$\{|^\$[A-Z_]|\{\{|YOUR_|example\.com/i.test(value))) continue;
        try {
          urls.push(
            buildConnectionUri(
              config.engine,
              ...(values as [string, string, string, string, string]),
            ),
          );
        } catch {
          result.notices.push(
            `Review the separate database settings in ${file.path}; some fields are incomplete.`,
          );
        }
      }
    }
    for (let uri of urls) {
      uri = uri.replace(/[,;]+$/, '');
      if (/\$\{|<|\{\{|YOUR_|example\.com/i.test(uri) || seen.has(uri)) continue;
      try {
        validateUri(uri);
      } catch {
        continue;
      }
      seen.add(uri);
      result.connections.push({
        engine: detectEngine(uri),
        uri,
        source: file.path,
        target: targetOf(uri),
      });
    }
    if (/package\.json$/.test(file.path))
      try {
        const p = JSON.parse(file.text);
        const deps = { ...p.dependencies, ...p.devDependencies };
        const frameworks: Record<string, string> = {
          '@prisma/client': 'Prisma',
          prisma: 'Prisma',
          typeorm: 'TypeORM',
          sequelize: 'Sequelize',
          mongoose: 'Mongoose',
          knex: 'Knex',
          drizzle: 'Drizzle',
          'drizzle-orm': 'Drizzle',
          pg: 'node-postgres',
          mysql2: 'MySQL2',
          mongodb: 'MongoDB driver',
          redis: 'Redis',
          mssql: 'SQL Server driver',
        };
        for (const [k, v] of Object.entries(frameworks)) if (k in deps) result.frameworks.push(v);
      } catch {
        result.notices.push(`Could not parse ${file.path}.`);
      }
    if (/\.prisma$/.test(file.path)) {
      result.frameworks.push('Prisma');
      for (const m of file.text.matchAll(/^\s*model\s+(\w+)\s*\{/gm))
        result.models.push({ name: m[1], source: file.path });
      for (const m of file.text.matchAll(
        /provider\s*=\s*"(postgresql|mysql|sqlite|sqlserver|mongodb|cockroachdb)"/g,
      ))
        result.notices.push(`Prisma provider: ${m[1]} (${file.path}).`);
    }
    if (/(?:models\.py|settings\.py)$/.test(file.path)) {
      result.frameworks.push('Django');
      for (const m of file.text.matchAll(/class\s+(\w+)\([^)]*models\.Model[^)]*\)/g))
        result.models.push({ name: m[1], source: file.path });
    }
    if (/\.(?:ts|js)$/.test(file.path)) {
      if (/@Entity\s*\(/.test(file.text)) {
        result.frameworks.push('TypeORM');
        for (const m of file.text.matchAll(/export\s+class\s+(\w+)/g))
          result.models.push({ name: m[1], source: file.path });
      }
      for (const m of file.text.matchAll(/(?:mongoose\.)?model\s*\(\s*['"]([^'"]+)/g)) {
        result.frameworks.push('Mongoose');
        result.models.push({ name: m[1], source: file.path });
      }
    }
  }
  result.frameworks = [...new Set(result.frameworks)];
  result.models = result.models.slice(0, 200);
  if (!result.connections.length)
    result.notices.push(
      'No usable database settings found. Use Connect a database to enter your details; unresolved environment variables need to be filled in.',
    );
  return result;
}

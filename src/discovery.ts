import { detectEngine, targetOf } from './security';
import { Discovery } from './types';
export function inspectFiles(files: { path: string; text: string }[]): Discovery {
  const result: Discovery = { connections: [], frameworks: [], models: [], notices: [] };
  const seen = new Set<string>();
  for (const file of files) {
    if (file.text.length > 1024 * 1024) continue;
    const urls =
      file.text.match(
        /(?:postgres(?:ql)?|mysql|mariadb|sqlserver|mssql|mongodb(?:\+srv)?|rediss?):\/\/[^\s"'`<>]+|(?:sqlite|file):\/\/\/[^\s"'`<>]+/gi,
      ) ?? [];
    for (let uri of urls) {
      uri = uri.replace(/[,;]+$/, '');
      if (/\$\{|<|\{\{|YOUR_|example\.com/i.test(uri) || seen.has(uri)) continue;
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
      'No literal connection URLs found. Environment substitutions and separate host/user/password settings require manual setup.',
    );
  return result;
}

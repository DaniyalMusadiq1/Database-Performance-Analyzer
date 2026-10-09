import { Profile } from './types';
export function loadProfiles(value: unknown): Profile[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.filter((p): p is Profile => {
    if (!p || typeof p !== 'object') return false;
    const valid =
      typeof p.id === 'string' &&
      /^[a-zA-Z0-9_-]{1,100}$/.test(p.id) &&
      p.id !== 'demo' &&
      !seen.has(p.id) &&
      typeof p.name === 'string' &&
      p.name.trim().length > 0 &&
      p.name.length <= 100 &&
      ['postgres', 'mysql', 'sqlserver', 'sqlite', 'mongodb', 'redis'].includes(p.engine) &&
      typeof p.target === 'string' &&
      p.target.length <= 2048 &&
      typeof p.tls === 'boolean' &&
      typeof p.createdAt === 'string';
    if (valid) seen.add(p.id);
    return valid;
  });
}
/** Serialize storage commits; a failed commit must not poison subsequent changes. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work);
    this.tail = next.catch(() => {});
    return next;
  }
}

import { Snapshot } from './types';
/** Retain recent snapshots within both connection-count and approximate serialized-byte limits. */
export class SnapshotHistory {
  private histories = new Map<string, { snapshot: Snapshot; bytes: number }[]>();
  private bytes = 0;
  constructor(
    private readonly maxBytes = 32 * 1024 * 1024,
    private readonly maxConnections = 10,
  ) {}
  add(id: string, snapshot: Snapshot, maxSamples: number): Snapshot[] {
    const entries = this.histories.get(id) ?? [];
    this.histories.delete(id);
    const bytes = Buffer.byteLength(JSON.stringify(snapshot));
    entries.push({ snapshot, bytes });
    this.bytes += bytes;
    while (entries.length > Math.max(1, maxSamples)) {
      this.bytes -= entries.shift()!.bytes;
    }
    this.histories.set(id, entries);
    while (this.histories.size > this.maxConnections)
      this.delete(this.histories.keys().next().value!);
    while (this.bytes > this.maxBytes && this.histories.size) {
      const key = this.histories.keys().next().value!;
      const list = this.histories.get(key)!;
      this.bytes -= list.shift()!.bytes;
      if (!list.length) this.histories.delete(key);
    }
    return this.get(id);
  }
  get(id: string): Snapshot[] {
    return (this.histories.get(id) ?? []).map((x) => x.snapshot);
  }
  delete(id: string) {
    for (const entry of this.histories.get(id) ?? []) this.bytes -= entry.bytes;
    this.histories.delete(id);
  }
  clear() {
    this.histories.clear();
    this.bytes = 0;
  }
  get retainedBytes() {
    return this.bytes;
  }
}
export function chartHistory(history: Snapshot[]) {
  return history.map(({ timestamp, metrics }) => ({ timestamp, metrics }));
}

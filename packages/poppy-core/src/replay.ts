/**
 * Remembers single-use values (`jti`s, codes) for a time window.
 * Async so a DynamoDB conditional-write version can replace it later (Task 13).
 */
export interface ReplayStore {
  /** Records `key` and returns true if it is new. Returns false if it was seen and hasn't expired. */
  checkAndAdd(key: string, ttlMs: number): Promise<boolean>;
}

/** In-memory replay store with TTL eviction and a size bound (SecurityReview T-19). */
export class MemoryReplayStore implements ReplayStore {
  private seen = new Map<string, number>();
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(opts: { maxEntries?: number; now?: () => number } = {}) {
    this.maxEntries = opts.maxEntries ?? 100_000;
    this.now = opts.now ?? Date.now;
  }

  async checkAndAdd(key: string, ttlMs: number): Promise<boolean> {
    const now = this.now();
    if ((this.seen.get(key) ?? 0) > now) return false;
    if (this.seen.size >= this.maxEntries) this.evict(now);
    if (this.seen.size >= this.maxEntries) throw new Error("replay store full");
    this.seen.set(key, now + ttlMs);
    return true;
  }

  get size(): number {
    return this.seen.size;
  }

  private evict(now: number): void {
    for (const [k, exp] of this.seen) if (exp <= now) this.seen.delete(k);
  }
}

import { BotStateStore } from "./persistence.js";

export class DeliveryIdempotencyStore {
  private readonly ttlMs: number;
  private readonly seen = new Map<string, number>();
  private readonly store?: BotStateStore;

  constructor(ttlMs = 24 * 60 * 60 * 1000, store?: BotStateStore) {
    this.ttlMs = ttlMs;
    this.store = store;
  }

  has(key: string): boolean {
    if (this.store) {
      return this.store.hasDedupKey(key);
    }
    this.gcMemory();
    return this.seen.has(key);
  }

  add(key: string): void {
    if (this.store) {
      this.store.putDedupKey(key, this.ttlMs);
      return;
    }
    this.gcMemory();
    this.seen.set(key, Date.now() + this.ttlMs);
  }

  private gcMemory(): void {
    const now = Date.now();
    for (const [key, expiresAt] of this.seen) {
      if (expiresAt <= now) {
        this.seen.delete(key);
      }
    }
  }
}

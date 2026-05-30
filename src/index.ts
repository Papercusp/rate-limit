/**
 * @papercusp/rate-limit — a generic two-bucket rate limiter.
 *
 *   (1) SOFT per-key: N attempts / window. Refundable (so a legitimate
 *       caller isn't penalized for an earlier failure that later
 *       succeeds).
 *   (2) HARD per-key: M failures / window → lockout. NOT refundable —
 *       the lockout IS the protection signal.
 *
 * Pure algorithm + injected storage. No DB, no domain coupling: the
 * caller supplies a `BucketStore` (PG, Redis, in-memory, …) and opaque
 * string keys. The canonical use is auth throttling (soft per-IP + hard
 * per-(IP,username)), but nothing here knows about IPs or users — the
 * key shapes are the caller's.
 */

/** Persisted state for one bucket. `recent` = ms timestamps of attempts
 *  (soft) or failures (hard); `lockedUntilMs` = 0 when not locked. */
export interface BucketPayload {
  recent: number[];
  lockedUntilMs: number;
}

/** What the limiter reads back from the store — possibly malformed jsonb,
 *  so the limiter normalizes it defensively. */
export type StoredBucket = { recent?: unknown; lockedUntilMs?: unknown } | null;

/** The injected storage seam. Implementations key on opaque strings and
 *  persist a `BucketPayload`. All ops are async. */
export interface BucketStore {
  read(key: string): Promise<StoredBucket>;
  write(key: string, payload: BucketPayload): Promise<void>;
  delete(key: string): Promise<void>;
  /** Best-effort GC: drop entries last touched before `olderThanMs`
   *  (a wall-clock ms threshold). Failures must be swallowed by the impl. */
  gcStale(olderThanMs: number): Promise<void>;
  /** Test/admin seam: drop every entry whose key starts with `prefix`. */
  clearPrefix(prefix: string): Promise<void>;
}

export interface RateLimitResult {
  ok: boolean;
  retryAfterS?: number;
}

export interface SoftBucketConfig {
  windowMs: number;
  capacity: number;
}
export interface HardBucketConfig {
  windowMs: number;
  capacity: number;
  lockoutMs: number;
}

export interface RateLimitConfig {
  store: BucketStore;
  soft?: SoftBucketConfig;
  hard?: HardBucketConfig;
  /** Entries untouched for this long are GC'd lazily on soft checks. */
  staleAfterMs?: number;
}

export const DEFAULT_SOFT: SoftBucketConfig = { windowMs: 60_000, capacity: 10 };
export const DEFAULT_HARD: HardBucketConfig = {
  windowMs: 15 * 60_000,
  capacity: 5,
  lockoutMs: 5 * 60_000,
};
export const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60_000;

/** True for loopback addresses (handles x-forwarded-for chains by taking
 *  the leftmost/origin hop). Pure helper, reusable on its own. */
export function isLoopbackIp(ip: string | null | undefined): boolean {
  if (!ip) return false;
  const trimmed = ip.trim();
  if (trimmed === '127.0.0.1' || trimmed === '::1' || trimmed === 'localhost') return true;
  const leftmost = trimmed.split(',')[0].trim();
  return leftmost === '127.0.0.1' || leftmost === '::1';
}

function normalize(raw: StoredBucket): BucketPayload {
  if (!raw) return { recent: [], lockedUntilMs: 0 };
  const recent = Array.isArray(raw.recent)
    ? raw.recent.map((n) => Number(n)).filter((n) => Number.isFinite(n))
    : [];
  const lockedUntilMs = typeof raw.lockedUntilMs === 'number' ? raw.lockedUntilMs : 0;
  return { recent, lockedUntilMs };
}

export interface RateLimiter {
  /** Soft check on `key` (e.g. `ip:<addr>`). Records the attempt when ok. */
  checkSoft(key: string): Promise<RateLimitResult>;
  /** Refund the most recent soft attempt on `key` (call after success). */
  refundSoft(key: string): Promise<void>;
  /** Hard check on `key` (e.g. `user:<addr>:<name>`). Read-only. */
  checkHard(key: string): Promise<RateLimitResult>;
  /** Record a hard failure on `key`; locks out once capacity is hit. */
  burnHard(key: string): Promise<void>;
  /** Clear the hard bucket for `key` (e.g. on successful auth). */
  resetHard(key: string): Promise<void>;
  /** Drop every bucket whose key starts with `prefix`. */
  clearPrefix(prefix: string): Promise<void>;
}

export function createRateLimiter(config: RateLimitConfig): RateLimiter {
  const store = config.store;
  const soft = config.soft ?? DEFAULT_SOFT;
  const hard = config.hard ?? DEFAULT_HARD;
  const staleAfterMs = config.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;

  return {
    async checkSoft(key) {
      const now = Date.now();
      await store.gcStale(now - staleAfterMs);
      const bucket = normalize(await store.read(key));
      const cutoff = now - soft.windowMs;
      const recent = bucket.recent.filter((ts) => ts > cutoff);
      if (recent.length >= soft.capacity) {
        const oldest = recent[0];
        const retryAfterS = Math.max(1, Math.ceil((oldest + soft.windowMs - now) / 1000));
        return { ok: false, retryAfterS };
      }
      recent.push(now);
      await store.write(key, { recent, lockedUntilMs: 0 });
      return { ok: true };
    },

    async refundSoft(key) {
      const bucket = normalize(await store.read(key));
      if (bucket.recent.length === 0) return;
      const recent = bucket.recent.slice(0, -1);
      if (recent.length === 0) {
        await store.delete(key);
      } else {
        await store.write(key, { recent, lockedUntilMs: 0 });
      }
    },

    async checkHard(key) {
      const now = Date.now();
      const bucket = normalize(await store.read(key));
      if (bucket.lockedUntilMs > now) {
        return { ok: false, retryAfterS: Math.max(1, Math.ceil((bucket.lockedUntilMs - now) / 1000)) };
      }
      return { ok: true };
    },

    async burnHard(key) {
      const now = Date.now();
      const bucket = normalize(await store.read(key));
      const cutoff = now - hard.windowMs;
      const recent = bucket.recent.filter((ts) => ts > cutoff);
      recent.push(now);
      const lockedUntilMs = recent.length >= hard.capacity ? now + hard.lockoutMs : 0;
      await store.write(key, { recent, lockedUntilMs });
    },

    async resetHard(key) {
      await store.delete(key);
    },

    async clearPrefix(prefix) {
      await store.clearPrefix(prefix);
    },
  };
}

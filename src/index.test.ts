import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  createRateLimiter,
  isLoopbackIp,
  DEFAULT_SOFT,
  DEFAULT_HARD,
  type BucketStore,
  type BucketPayload,
  type StoredBucket,
} from './index';

/** Minimal in-memory BucketStore for unit tests. */
function memStore(): BucketStore & { map: Map<string, BucketPayload> } {
  const map = new Map<string, BucketPayload>();
  return {
    map,
    async read(key): Promise<StoredBucket> {
      return map.get(key) ?? null;
    },
    async write(key, payload) {
      map.set(key, payload);
    },
    async delete(key) {
      map.delete(key);
    },
    async gcStale() {
      /* no-op for tests */
    },
    async clearPrefix(prefix) {
      for (const k of [...map.keys()]) if (k.startsWith(prefix)) map.delete(k);
    },
  };
}

/** A store whose `read` hands back whatever raw (possibly malformed) jsonb the
 *  caller seeded — the seam normalize() must defend against. `writes` records
 *  every payload the limiter persists so a test can inspect the cleaned value. */
function rawStore(seed: Record<string, StoredBucket> = {}): BucketStore & {
  reads: Record<string, StoredBucket>;
  writes: Array<{ key: string; payload: BucketPayload }>;
} {
  const reads: Record<string, StoredBucket> = { ...seed };
  const writes: Array<{ key: string; payload: BucketPayload }> = [];
  return {
    reads,
    writes,
    async read(key): Promise<StoredBucket> {
      return key in reads ? reads[key] : null;
    },
    async write(key, payload) {
      reads[key] = payload;
      writes.push({ key, payload });
    },
    async delete(key) {
      delete reads[key];
    },
    async gcStale() {
      /* no-op */
    },
    async clearPrefix(prefix) {
      for (const k of Object.keys(reads)) if (k.startsWith(prefix)) delete reads[k];
    },
  };
}

afterEach(() => vi.useRealTimers());

describe('normalize — malformed jsonb is coerced defensively (R1)', () => {
  it('a non-array recent + non-number lockedUntilMs become [] / 0, and checkSoft writes a clean recent', async () => {
    const store = rawStore({
      'ip:bad': { recent: 'not-an-array', lockedUntilMs: 'soon' } as StoredBucket,
    });
    const rl = createRateLimiter({ store });
    // recent coerces to [] (not iterable garbage) so the soft check is ok.
    const r = await rl.checkSoft('ip:bad');
    expect(r.ok).toBe(true);
    // it persisted a clean BucketPayload: recent is a 1-element array of a finite ts.
    const last = store.writes.at(-1)!;
    expect(last.key).toBe('ip:bad');
    expect(Array.isArray(last.payload.recent)).toBe(true);
    expect(last.payload.recent).toHaveLength(1);
    expect(Number.isFinite(last.payload.recent[0])).toBe(true);
    expect(last.payload.lockedUntilMs).toBe(0);
  });

  it('a recent array with NaN/Infinity/garbage keeps only the finite timestamps', async () => {
    const goodTs = 1_700_000_000_000;
    const store = rawStore({
      'user:bad': {
        recent: [NaN, 'x', Infinity, goodTs] as unknown as number[],
        lockedUntilMs: null,
      } as StoredBucket,
    });
    const rl = createRateLimiter({ store });
    // lockedUntilMs:null normalizes to 0 -> not locked.
    expect((await rl.checkHard('user:bad')).ok).toBe(true);
    // burnHard re-reads the same malformed bucket: only the one finite ts survived
    // normalization, so the in-window set is [goodTs] before this burn appends.
    await rl.burnHard('user:bad');
    const persisted = store.reads['user:bad'] as BucketPayload;
    // every persisted timestamp is finite (NaN/Infinity/'x' were dropped).
    for (const ts of persisted.recent) expect(Number.isFinite(ts)).toBe(true);
    expect(persisted.recent.length).toBeGreaterThanOrEqual(1);
  });
});

describe('soft window — stale timestamps fall out of the window (R2)', () => {
  it('a timestamp older than the window is excluded, the check is ok, and it is not re-persisted', async () => {
    const windowMs = 60_000;
    const staleTs = Date.now() - 120_000; // two windows old
    const store = rawStore({
      'ip:stale': { recent: [staleTs], lockedUntilMs: 0 },
    });
    const rl = createRateLimiter({ store, soft: { windowMs, capacity: 1 } });
    // capacity is 1, but the only existing attempt is stale -> it doesn't count,
    // so the new attempt is admitted.
    const r = await rl.checkSoft('ip:stale');
    expect(r.ok).toBe(true);
    expect(r.retryAfterS).toBeUndefined(); // no retry on a successful check
    // the persisted recent dropped the stale ts and holds only the fresh one.
    const persisted = store.reads['ip:stale'] as BucketPayload;
    expect(persisted.recent).not.toContain(staleTs);
    expect(persisted.recent).toHaveLength(1);
    expect(persisted.recent[0]).toBeGreaterThan(staleTs);
  });
});

describe('checkHard — lock-expiry boundary is strict greater-than (R3)', () => {
  it('lockedUntilMs === now is NOT locked; now + 1 IS locked', async () => {
    const NOW = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    // Boundary: the lock check is `lockedUntilMs > now`, so equal-to-now is open.
    const atBoundary = rawStore({ 'user:k': { recent: [], lockedUntilMs: NOW } });
    const rlAt = createRateLimiter({ store: atBoundary });
    expect((await rlAt.checkHard('user:k')).ok).toBe(true);

    // One ms past now is still in the future -> blocked, with a >=1 retryAfterS.
    const justAfter = rawStore({ 'user:k': { recent: [], lockedUntilMs: NOW + 1 } });
    const rlAfter = createRateLimiter({ store: justAfter });
    const blocked = await rlAfter.checkHard('user:k');
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterS).toBeGreaterThanOrEqual(1);
  });
});

describe('createRateLimiter — soft bucket', () => {
  it('allows up to capacity, blocks the next with retryAfterS', async () => {
    const rl = createRateLimiter({ store: memStore() });
    for (let i = 0; i < DEFAULT_SOFT.capacity; i++) {
      expect((await rl.checkSoft('ip:1.2.3.4')).ok).toBe(true);
    }
    const blocked = await rl.checkSoft('ip:1.2.3.4');
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterS).toBeGreaterThan(0);
  });

  it('refundSoft pops the most recent attempt, freeing a slot', async () => {
    const rl = createRateLimiter({ store: memStore() });
    for (let i = 0; i < DEFAULT_SOFT.capacity; i++) await rl.checkSoft('ip:k');
    expect((await rl.checkSoft('ip:k')).ok).toBe(false); // at capacity
    await rl.refundSoft('ip:k');
    expect((await rl.checkSoft('ip:k')).ok).toBe(true); // one slot back
  });

  it('refundSoft on an empty bucket is a no-op', async () => {
    const rl = createRateLimiter({ store: memStore() });
    await rl.refundSoft('ip:never'); // must not throw
    expect((await rl.checkSoft('ip:never')).ok).toBe(true);
  });
});

describe('createRateLimiter — hard bucket', () => {
  it('locks out after capacity burns; checkHard reports retryAfterS', async () => {
    const rl = createRateLimiter({ store: memStore() });
    for (let i = 0; i < DEFAULT_HARD.capacity; i++) await rl.burnHard('user:k');
    const r = await rl.checkHard('user:k');
    expect(r.ok).toBe(false);
    expect(r.retryAfterS).toBeGreaterThan(0);
  });

  it('checkHard is ok below capacity and after reset', async () => {
    const rl = createRateLimiter({ store: memStore() });
    for (let i = 0; i < DEFAULT_HARD.capacity - 1; i++) await rl.burnHard('user:k');
    expect((await rl.checkHard('user:k')).ok).toBe(true);
    await rl.burnHard('user:k'); // hit capacity
    expect((await rl.checkHard('user:k')).ok).toBe(false);
    await rl.resetHard('user:k');
    expect((await rl.checkHard('user:k')).ok).toBe(true);
  });

  it('an expired lockout does NOT re-lock on the first new failure (audit P-023)', async () => {
    // windowMs > lockoutMs (like the defaults, 15m vs 5m): after the lockout
    // lapses, the original burns are still inside the window — the old code
    // counted them again and re-locked on the very next burnHard.
    const store = memStore();
    const rl = createRateLimiter({
      store,
      hard: { windowMs: 15 * 60_000, capacity: 3, lockoutMs: 5 * 60_000 },
    });
    for (let i = 0; i < 3; i++) await rl.burnHard('user:k');
    expect((await rl.checkHard('user:k')).ok).toBe(false);

    // Simulate the lockout lapsing (burn timestamps stay in-window).
    const bucket = store.map.get('user:k')!;
    store.map.set('user:k', { ...bucket, lockedUntilMs: Date.now() - 1 });
    expect((await rl.checkHard('user:k')).ok).toBe(true);

    // First post-lockout failure: a fresh strike, NOT an instant re-lock.
    await rl.burnHard('user:k');
    expect((await rl.checkHard('user:k')).ok).toBe(true);
    expect(store.map.get('user:k')!.recent).toHaveLength(1);

    // Capacity fresh failures still re-lock normally.
    await rl.burnHard('user:k');
    await rl.burnHard('user:k');
    expect((await rl.checkHard('user:k')).ok).toBe(false);
  });
});

describe('config + clearPrefix', () => {
  it('honors custom capacities', async () => {
    const rl = createRateLimiter({ store: memStore(), soft: { windowMs: 1000, capacity: 2 } });
    expect((await rl.checkSoft('ip:x')).ok).toBe(true);
    expect((await rl.checkSoft('ip:x')).ok).toBe(true);
    expect((await rl.checkSoft('ip:x')).ok).toBe(false);
  });

  it('clearPrefix drops matching keys only', async () => {
    const store = memStore();
    const rl = createRateLimiter({ store });
    await rl.checkSoft('ip:a');
    await rl.burnHard('user:b');
    await rl.clearPrefix('ip:');
    expect(store.map.has('ip:a')).toBe(false);
    expect(store.map.has('user:b')).toBe(true);
  });
});

describe('isLoopbackIp', () => {
  it('recognizes loopback + handles x-forwarded-for chains', () => {
    expect(isLoopbackIp('127.0.0.1')).toBe(true);
    expect(isLoopbackIp('::1')).toBe(true);
    expect(isLoopbackIp('localhost')).toBe(true);
    expect(isLoopbackIp('10.0.0.1')).toBe(false);
    expect(isLoopbackIp('')).toBe(false);
    expect(isLoopbackIp(null)).toBe(false);
    expect(isLoopbackIp('127.0.0.1, 10.0.0.5')).toBe(true);
    expect(isLoopbackIp('10.0.0.5, 127.0.0.1')).toBe(false);
  });

  it('recognizes IPv4-mapped-IPv6 loopback and all of 127/8', () => {
    expect(isLoopbackIp('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackIp('::FFFF:127.0.0.1')).toBe(true); // case-insensitive
    expect(isLoopbackIp('127.0.0.53')).toBe(true); // 127/8 is all loopback
    expect(isLoopbackIp('127.1.2.3')).toBe(true);
    expect(isLoopbackIp(' ::ffff:127.0.0.1 , 10.0.0.5')).toBe(true);
    // Not loopback — must stay rate-limited.
    expect(isLoopbackIp('::ffff:10.0.0.1')).toBe(false);
    expect(isLoopbackIp('128.0.0.1')).toBe(false);
  });
});

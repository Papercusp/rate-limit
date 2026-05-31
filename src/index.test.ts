import { describe, it, expect } from 'vitest';
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

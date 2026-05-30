# @papercusp/rate-limit

A generic two-bucket rate limiter — the algorithm only; you supply storage.

```ts
import { createRateLimiter, type BucketStore } from '@papercusp/rate-limit';

const store: BucketStore = /* PG, Redis, in-memory … */;
const rl = createRateLimiter({
  store,
  soft: { windowMs: 60_000, capacity: 10 },                 // refundable per-key throttle
  hard: { windowMs: 15 * 60_000, capacity: 5, lockoutMs: 5 * 60_000 }, // lockout per-key
});

// soft: refundable attempt throttle (e.g. per-IP)
if (!(await rl.checkSoft(`ip:${ip}`)).ok) return tooMany();
// … on success: await rl.refundSoft(`ip:${ip}`)

// hard: failure lockout (e.g. per-(IP,username))
if (!(await rl.checkHard(`user:${ip}:${name}`)).ok) return lockedOut();
// … on failure: await rl.burnHard(`user:${ip}:${name}`)
// … on success: await rl.resetHard(`user:${ip}:${name}`)
```

**Soft** = N attempts / window, *refundable* (don't punish a legit caller for a
typo that later succeeds). **Hard** = M failures / window → lockout, *not*
refundable (the lockout is the signal).

Pure: no DB, no network, no domain coupling — keys are opaque strings the caller
shapes, and storage is the injected `BucketStore`. `isLoopbackIp()` is exported
as a reusable helper (handles `x-forwarded-for` chains) for the common
auth-throttle case, but the limiter itself knows nothing about IPs or users.

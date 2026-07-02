# Plan: Add rate limiting to the public API

## Context

The public API currently has no rate limiting. A single misbehaving client
can saturate the worker pool and degrade latency for everyone. This plan
adds per-client rate limiting at the gateway layer.

## Approach

Use a token-bucket limiter keyed by API key, enforced in the gateway
middleware before requests reach route handlers.

> Out of scope: per-endpoint quotas and billing-tier integration. Both can
> layer on top of this work later.

## Steps

1. Add a `RateLimiter` module with a token-bucket implementation
2. Wire it into the gateway middleware chain
   - reject with `429 Too Many Requests` and a `Retry-After` header
   - exempt internal health-check routes
3. Emit `rate_limited` metrics tagged by client
4. Roll out behind the `rate-limiting` feature flag

## Storage decision

The limiter needs shared state across gateway instances. Redis is the
default candidate, but an in-process store would be simpler if we accept
per-instance limits during the first rollout.

```choice
id: storage
prompt: Where should limiter state live for the first rollout?
options:
  - Redis — shared limits across all gateway instances
  - In-process — simpler, accepts per-instance limits initially
  - In-process now, Redis behind the feature flag later
```

## Defaults

| Setting | Value | Notes |
| --- | --- | --- |
| Bucket size | 60 | burst allowance |
| Refill rate | 1/sec | steady-state 60 req/min |
| Key | API key | falls back to client IP |

## Rollout checklist

- [ ] Limiter module with unit tests
- [ ] Gateway middleware integration
- [ ] Metrics dashboard panel
- [ ] Enable flag in staging for 48h
- [ ] Enable flag in production

```js
// sketch of the middleware
app.use(rateLimit({ bucket: 60, refillPerSec: 1, keyBy: (req) => req.apiKey }));
```

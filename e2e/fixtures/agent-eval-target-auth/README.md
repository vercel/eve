# Short-lived eval target credentials

The target accepts only HMAC session tokens that expire after three seconds,
with no clock skew allowance, and rejects anything else. `evals.config.ts`
sets `targetAuth: { bearer: () => mintToken() }`, so `eve eval` mints a fresh
token for every request. The eval outlives several token lifetimes across a
stubbed lookup, an approval response, and the runner's final stub check, and
confirms the target rejects the first token once it has expired.

It runs with the mock model in `e2e-local` against the local dev server. The
Postgres suite uses `eve eval --url` with an HTTP loopback target, which cannot
receive workspace `targetAuth`. The signing secret is a fixture constant, not a
credential.

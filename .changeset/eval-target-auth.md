---
"eve": minor
---

Set `targetAuth` in `evals.config.ts` to send credentials to eval targets, with token functions that `eve eval` calls before every request.

For the local dev server, pass client credentials such as `{ bearer: () => getSessionToken() }`. For `--url`, pass a function that checks the target's HTTPS origin before returning credentials. Returning `undefined` keeps the default Vercel credential lookup. `EVE_EVAL_AUTH_TOKEN` and `EVE_EVAL_OIDC_TOKEN` still take precedence for `--url` runs, and eve warns when either overrides `targetAuth`.

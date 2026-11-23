---
"eve": minor
---

Set `targetAuth` in `evals.config.ts` to send credentials to eval targets, with token functions that `eve eval` calls before every request.

`targetAuth` takes the same shape as the eve client's `auth`, such as `{ bearer: () => getSessionToken() }`, so targets that use short-lived session tokens keep the same caller for the whole run. For `--url`, list the target's exact HTTPS origin in `targetAuthOrigins` before eve can use workspace credentials. The local dev server needs no allowlist, and `EVE_EVAL_AUTH_TOKEN` and `EVE_EVAL_OIDC_TOKEN` still take precedence for `--url` runs.

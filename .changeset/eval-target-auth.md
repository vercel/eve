---
"eve": minor
---

Set `targetAuth` in `evals.config.ts` to send credentials to eval targets, with a token function that `eve eval` calls before every request.

`eve eval` previously sent `EVE_EVAL_AUTH_TOKEN` as one static bearer for the whole run, so targets that authenticate with short-lived session tokens saw an expired, anonymous caller partway through a multi-turn eval. `targetAuth` takes the same shape as the eve client's `auth`, such as `{ bearer: () => getSessionToken() }`, and applies to the local dev server as well as `--url` targets. On a remote target, `EVE_EVAL_AUTH_TOKEN` and `EVE_EVAL_OIDC_TOKEN` still take precedence.

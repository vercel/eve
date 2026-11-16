# Provider regression checks

Run `pnpm check` for the normal credential-free checks. Live provider tests are
opt-in and use real service resources. Keep credentials in ignored environment files.
Browserbase must use `verified: true` and managed proxies, including after launch retries.

## Parallel research to browser

Set `OPENAI_API_KEY`, `PARALLEL_API_KEY`, and `BROWSERBASE_API_KEY` in ignored `.env.local`.
Install Chrome or set `TEST_CHROME_PATH`, then run:

```sh
BELL_LIVE_PARALLEL=1 pnpm test:parallel:production
```

The runner starts isolated, authenticated production services and checks two concurrent
conversations, citations, stream recovery, browser handoff, credential non-disclosure, and cleanup.
Reports stay in ignored `.bell/parallel-e2e/`; failures, including cleanup failures, exit nonzero.

For an existing instance, set `BELL_TEST_ORIGIN` and run `BELL_LIVE_PARALLEL=1 pnpm test:parallel:live`.
Remote staging requires the same HTTPS `BELL_TEST_STAGING_ORIGIN`, the deployment's operator
credentials (password at least 32 bytes), and `BELL_TEST_PROTECTION_BYPASS` if protected.
The runner sends credentials only to that exact origin. Local success does not certify staging.

## 1Password login and OTP

Use a dedicated test vault with a Login item titled exactly
`Bell integration test (authenticationtest.com)`. Give it the website
`https://authenticationtest.com` and the public test username, password, and OTP seed shown
on [the test site's TOTP challenge](https://authenticationtest.com/totpChallenge/).
Do not point the test at a personal or production login.

Configure `BROWSERBASE_API_KEY` and either `OP_SERVICE_ACCOUNT_TOKEN` or desktop integration
through `OP_ACCOUNT`. From the repository root:

```sh
BELL_LIVE_ONEPASSWORD=1 STAGEHAND_BROWSER=browserbase \
  node --env-file-if-exists=.env --env-file-if-exists=.env.local \
  node_modules/vitest/vitest.mjs run tests/browser/onepassword-login-real.test.ts
```

The test resolves the OTP after navigation, submits the dedicated test login, checks the
success page, and asserts that the returned result and traces omit the credentials.
Without the dedicated fixture, report this check as unverified even if vault listing works.

## Saved Browserbase Context

With the Browserbase environment loaded, run:

```sh
BELL_LIVE_CONTEXT=1 STAGEHAND_BROWSER=browserbase pnpm exec vitest run tests/browser/context-save-real.test.ts
```

This writes a synthetic example.com cookie, releases the writer, starts a reader with the
same Context, and checks the restored cookie. It then releases both browsers and deletes the
temporary Context. Cleanup failures must fail the check rather than silently leaving resources.

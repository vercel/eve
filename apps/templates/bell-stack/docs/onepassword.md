# Personal 1Password through Bell

This integration connects an allowlisted private Linq sender to their personal 1Password account. It uses Agentic Autofill in the 1Password browser extension. The operator SDK/CLI vault tools remain separate and are unavailable to Linq senders.

## Current status: disabled pending hosted extension support

Keep `ONEPASSWORD_ENABLED=false` (the default) and `BROWSERBASE_1PASSWORD_EXTENSION_ID` unset. Saved OAuth client settings alone do not enable personal connections. Connect and login tools stop before requesting authorization, the connection-start endpoint returns HTTP 503, and status reports `disabled`. Ordinary browsing keeps its existing Stagehand extension. Existing callback completion and disconnect remain available for recovery; disabling new connections does not erase credentials or weaken the private-browser guards.

The hosted check on October 25, 2026 verified the official 1Password Nightly extension 8.12.46.17 initializes and enables Agentic Mode in Browserbase by itself. Bell's Stagehand 4.3.0 launch fails with the same upload: supplying `extensionId` suppresses Stagehand's runtime upload, so attachment fails with `Stagehand extension is not installed in the connected browser`. Local Chrome can load both extensions, but that does not verify the hosted launch path. The [multi-extension platform proposal](https://github.com/browserbase/core/pull/10559) was closed without merging.

Run `pnpm repro:stagehand-extensions` with a Browserbase API key and optional project ID to reproduce the problem using a disposable synthetic extension. The `zip` command must be installed. It compares Stagehand alone, the custom extension alone, and Stagehand with that extension; it never needs OAuth or vault credentials. The script creates short-lived sessions with recording/logging disabled, releases them, and deletes its uploaded extension. A nonzero exit reports a failed case.

Before changing the flag to `true`, the platform and SDK must support loading both unmodified extensions in the same hosted session without suppressing Stagehand's runtime. Verify launch, reconnection, same-session login and subsequent browsing, cleanup on failure, and disabled recording/logging. Then complete the two-user consent and login checks below. The flag is a rollout control, not a workaround for the missing platform capability.

## Deployment setup

1. Apply `migrations/002_onepassword.sql` to Bell's PostgreSQL database. Use a direct or session-pooled connection: transaction-pooling proxies do not preserve the session advisory locks used for token rotation and browser operations.
2. Configure these server-only settings on every instance:

   | Setting | Purpose |
   | --- | --- |
   | `DATABASE_URL` | Shared durable connection records, refresh locks, and browser guards. |
   | `ONEPASSWORD_ENABLED` | `false` until hosted extension support and live verification are complete; only the exact value `true` enables new connections and logins. |
   | `BELL_PUBLIC_URL` | Exact public HTTPS origin, without a trailing slash. |
   | `ONEPASSWORD_CLIENT_ID` | Registered production OAuth client. |
   | `ONEPASSWORD_CLIENT_SECRET` | Backend credential for token exchange. |
   | `ONEPASSWORD_REDIRECT_URI` | Exactly `<BELL_PUBLIC_URL>/api/onepassword/callback`. |
   | `ONEPASSWORD_TOKEN_ENCRYPTION_KEY` | Stable 32-byte base64 key; generate with `openssl rand -base64 32`. Back it up with the database and do not rotate by overwriting it. |
   | `BROWSERBASE_API_KEY` | Browserbase access. |
   | `BROWSERBASE_PROJECT_ID` | Optional when the project is inferred from the API key. |
   | `BROWSERBASE_1PASSWORD_EXTENSION_ID` | Browserbase upload ID for the supported Agentic Autofill extension. This enables personal-browser mode. |

3. Register the OAuth client through a 1Password Business account. The connecting test user needs a separate US Individual or Families account and the supported desktop app/extension. Follow the current [Browserbase setup guide](https://docs.browserbase.com/integrations/1password/agentic-autofill) for partner access and extension packaging. A regular service-account token is not a replacement for this client or extension.
4. Keep the public callback and `/eve/v1/connections/.../callback/...` paths reachable through Vercel protection without adding query parameters to the registered redirect. The callbacks use server-issued, short-lived capabilities; do not make unrelated application routes public.
5. Keep Linq signature verification, receiving-line configuration, and the sender allowlist enabled. Groups are deliberately rejected. The web operator login does not establish an individual iMessage identity and cannot select someone else's personal account.
6. Start new conversations for the rollout. Remove `BROWSERBASE_CONTEXT_ID` when personal-browser mode is enabled. Bell disables reusable Context creation, selection, saving, and cookie export in this mode. Existing contexts are not deleted, and their cookies are not migrated into personal sessions. Disable the old `ONEPASSWORD_OAUTH_STATE_SECRET`; the new record encryption key replaces its use.

Setting the extension upload ID changes browser launch configuration. Stagehand 4 also needs its own extension. Bell requires Stagehand initialization and the 1Password runtime API to succeed in the same session; failures stop the operation and do not fall back to reading passwords through the SDK. The local synthetic test verifies coexistence in Chrome. Verify the actual hosted extension combination before enabling this on a public deployment; an upload ID alone is not proof of compatibility.

## User flow

- Ask Bell to connect 1Password. Eve sends the consent link to the authenticated private conversation and resumes that conversation after the callback.
- Ask Bell to sign in, supplying the exact HTTPS login page and the expected success page on the same origin. Bell opens the login page in the conversation's browser and sends a private approval-page link.
- Open that page on the computer running the 1Password desktop app, then open and approve the requested login. The page checks approval for up to two minutes. Afterward, the user can request one more check. A request that remains pending after that check ends; ask Bell for a new login request.
- Bell matches the approved entry ID, fills through the extension, checks the destination's origin and path, and continues using that same browser.
- Ask Bell to disconnect 1Password to revoke the entire connection. This requires Eve confirmation. Failed revocation blocks credential use while retaining the encrypted credentials for retry.

The first implementation handles a single login per request and one pending request per sender. Multi-page sign-in, OTP, passkeys, and a persistent library of reusable grants are not implemented. An unexpected destination or failed fill closes and blocks the browser; start a new conversation. Reaching the expected URL is not an independent proof of account identity or authorization on the destination website.

## Ownership and recovery

The connection owner comes from Eve's signature-verified Linq principal, never a model argument or caller-supplied phone number. AES-GCM binds the encrypted record to that owner. The integration key is validated against the OAuth client, API host, account, and user path. A reconnect with an omitted key preserves the stored key and requires matching provider user identity. If identity cannot be established, Bell refuses to activate the connection.

The callback captures the integration key from the fragment, posts it through a same-origin, browser-bound endpoint, saves it before code exchange, and clears the browser URL. Nothing stores the key in localStorage, sessionStorage, model output, or an environment variable. See [1Password's storage contract](https://www.1password.dev/agentic-autofill/partners/keys-and-tokens).

Refreshes are serialized across processes. Bell commits a blocked state before sending a single-use code or refresh token. If a response or final database acknowledgment is lost, Bell requires recovery rather than retrying an ambiguously consumed token. A failed exchange retains the captured key. A missing key requires disconnecting and reconnecting; an account switch requires disconnecting the existing connection first.

Browser operations are serialized across workers while personal mode is enabled. A committed guard blocks subsequent operations if a fill is interrupted. Only a verified successful fill clears the guard. Logging and recording remain disabled. Access tokens and integration keys reach only the extension worker in memory; refresh tokens and client secrets remain on the server. Close the browser when the task ends. Human Live View still grants control to whoever holds its link, so keep it private.

Do not switch personal mode off while its conversations remain active. Retire those browsers before changing extension or privacy configuration. Removing the encryption key or database tables is not a rollback strategy: it prevents revocation and recovery.

## Verification

`pnpm test` includes synthetic OAuth, per-sender isolation, browser binding, durable completion, approval, failure, and refresh-concurrency tests. To run the database checks, point `TEST_ONEPASSWORD_DATABASE_URL` and `TEST_LINK_DATABASE_URL` at a disposable PostgreSQL instance; each suite creates its own schema. They never load live provider credentials.

On macOS with Chrome installed, run `BELL_TEST_LOCAL_CHROME=1 pnpm exec vitest run tests/onepassword-browser.test.ts` to exercise the real extension-worker bridge and callback JavaScript. That suite uses a synthetic extension and intercepted fixture websites. It does not verify 1Password's real consent or approval service.

Before launch, verify the deployed flow with two allowlisted test senders and test-vault logins: connect, approve, reach the expected destination, continue in the same browser, deny another request, reconnect without a new key, and disconnect. Confirm sender B cannot use sender A's connection or browser cookies. Inspect failure handling after revocation and a browser restart. The actual desktop approval and hosted Stagehand/1Password extension combination are required live checks.

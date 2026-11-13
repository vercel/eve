# Link by Stripe: sandbox and wallet OAuth over Linq

Link by Stripe provides wallet authorization, spend approval, and checkout. Linq carries the
messages; Eve by Vercel runs the agent and authorization flow. These are separate integrations.

## Sandbox: no database or saved wallet credentials

Run a single long-lived Eve process with `LINK_SANDBOX=1`. Inject
`LINK_SANDBOX_ACCESS_TOKEN` into its environment and set `LINK_SANDBOX_PRINCIPAL_ID` to the
verified operator's Linq principal (`linq:<sender_handle.id>` from the signed Linq event,
not a phone number). Keep the Linq receiving-number and sender allowlist checks enabled.
The token is obtained through the operator's Link application and is never requested in chat.
Bell does not write it to a file, database, workflow state, or model output. Do not save it in
`.env` or commit it. No `DATABASE_URL`, migrations, OAuth client, or encryption key is needed
for this sandbox path. Other sender identities and the anonymous web demo cannot use the token.

Every creation is forced to `test: true`; the model cannot enable a real charge. Stripe
[test requests](https://docs.stripe.com/agentic-commerce/agents/link-agent-wallet/use-link-wallet-pay-online#test-your-integration)
return test credentials without charging the underlying payment method. Bell uses a fresh
process-specific idempotency namespace and only permits requests created by that process.
Saved wallet profiles, payment methods, shipping addresses, and financial-history tools are
unavailable. Lists contain only this process's test requests. Approval and private card entry
work as described below. Use a merchant test checkout; do not place real fulfillment orders.

Request IDs and browser privacy locks exist only in process memory. After private card entry,
the model cannot inspect that browser again. After a restart or worker change, old request IDs
and recovered checkout browsers are refused, including when conversations survive. Use human
handoff to reconcile an existing attempt; do not restart or create another request to retry it.
This sandbox path is for one long-lived worker, not a multi-instance or serverless deployment.
It does not refresh or persist the token. Replace an expired token through the operator's Link
application and restart deliberately; revoke access there when finished. Bell's disconnect
tool does not claim to revoke the externally managed sandbox token.

Conversation history, task state, and non-secret test purchase/status messages still use Eve's
existing storage. Browserbase logging and recording remain disabled. Link and the test merchant
retain their own records; Bell's no-wallet-storage rule does not control those applications.

## Real Link: operator-owned OAuth and storage

Bell connects a wallet to the verified sender of a private Linq message. The user texts Bell,
opens Link's consent page, and returns to the same conversation. Eve suspends and resumes the
tool call. There is no Bell login, static wallet token, or wallet access from the web demo.

This uses the [Link Eve extension](https://eve.dev/integrations/link) and its
[interactive OAuth contract](https://github.com/stripe/link-cli/tree/main/packages/integrations/eve).
The Eve catalog's static-token quick start is not Bell's configuration.

## Configure real Link

1. Complete [Linq setup](linq.md), including signed webhooks and the trusted-number allowlist.
   Retain the private-operator policy: saved browser Contexts and vaults are still shared.
2. [Register a Link OAuth client](https://docs.stripe.com/agentic-commerce/link-cli/oauth).
   Register exactly `https://<bell-host>/api/link/oauth/callback`. Register every deployment
   separately. A local callback can be `http://127.0.0.1:4320/api/link/oauth/callback`, but a phone
   cannot reach that loopback address.
3. Provide PostgreSQL and set these server-only environment variables:

   ```dotenv
   BELL_PUBLIC_URL=https://<bell-host>
   DATABASE_URL=postgresql://<user>:<password>@<host>/<database>
   LINK_CLIENT_ID=<registered client ID>
   LINK_CLIENT_SECRET=<registered client secret>
   STRIPE_PUBLISHABLE_KEY=<your Stripe publishable key>
   LINK_TOKEN_ENCRYPTION_KEY=<base64 encryption key>
   ```

   Generate the encryption key once with `openssl rand -base64 32`. Keep it stable across
   restarts and identical on all instances. Back it up separately from PostgreSQL. Replacing it
   without re-encrypting records makes existing grants unreadable, including for revocation.
   Use your database provider's verified TLS configuration; do not disable certificate checks.
4. From the repository root, with `DATABASE_URL` exported in your shell, apply the migration:

   ```sh
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/001_link_oauth.sql
   ```

   Apply before accepting Link requests. It is safe to rerun and does not migrate browser data.
   The application needs SELECT/INSERT/UPDATE/DELETE on these tables. Schema management can use
   a separate database role.
5. Restart Bell. Expose `/api/link/oauth/callback` and Eve's
   `/eve/v1/connections/.../callback/...` routes without an interactive login wall. Opaque OAuth
   state and the framework callback capability protect these routes. Keep the existing web and
   session-control access restrictions. Bell forwards Eve's callback capability through
   `BELL_PUBLIC_URL`, even when Eve generated it on an internal development port or a
   different Vercel project domain. Route that public origin to this same Bell deployment.

Configuration and database connections load only when Link is used. Browsing and builds do not
require these values. Grants request only `payment_methods.agentic` and `userinfo:read`;
financial-data tools are disabled.

## Connect and purchase with real Link

Text **“List my Link payment methods.”** Bell sends a private consent link. Complete Link's
authentication and consent within ten minutes. Eve resumes the request in the original chat.
Keep consent links private: possession allows completing the connection for the requesting
sender. Denial or expiry ends the attempt; ask Bell for a new link when ready.

For checkout, give Bell the merchant, item, quantity, and budget. Bell confirms the final total,
including shipping and tax. Eve confirmation and Link approval are both retained. Bell checks
the same request and uses `link__checkout` to retrieve and submit credentials server-side in the
existing browser. The model receives status metadata, never card numbers, CVCs, or payment tokens.
Human handoff is reserved for 3DS and other human-only steps. A submission or confirmation element
is not proof of payment: Bell must verify the merchant receipt/order and Link status before reporting
success. An uncertain submission must be reconciled before retrying.

For real Link (`LINK_SANDBOX=0`), apply `migrations/003_link_checkout.sql` before deploying checkout. Browser operations use a
PostgreSQL session advisory lock while Link is configured, so use direct or session-pooled
connections. A committed privacy guard blocks later automation once payment entry begins, including after success, failure, or a worker restart. Handoff can still inspect the existing purchase; a new conversation must not retry an
uncertain purchase. The guard contains only the conversation ID and timestamp, never credentials.

Checkout supports virtual-card inputs (including MM/YY or separate expiry fields) and billing
addresses. Shared Payment Token API/MPP and Stripe Link Pay Token submission are not implemented
by this tool; their metadata tools remain available. Do not substitute a token for a card. Targets are exact CSS selectors,
optionally inside one iframe. By default, both the page and payment frame must have the approved
merchant's exact HTTPS origin. For a hosted checkout or payment iframe, explicitly configure
`LINK_CHECKOUT_ORIGINS` as a JSON mapping from merchant origins to trusted payment origins, e.g.
`{"https://shop.example":["https://checkout.payment.example"]}`. Never derive this mapping from
model input or page content. A different amount, currency, or merchant requires matching approval.

Browserbase logging and recording stay disabled. The operation serializes fills and browser reads,
clears reachable payment fields and retains the privacy guard. Merchant scripts may retain copies
that clearing inputs cannot erase, so the model cannot read this browser again. Do not capture
screenshots while payment details are visible. Test the actual merchant and credential format in a
sandbox before enabling production checkout.

Text **“Disconnect my Link wallet.”** After confirmation, Bell blocks token resolution,
invalidates pending consent attempts, and revokes the remote grant before removing its tokens.
If revocation fails, encrypted tokens remain for retrying disconnect and the wallet stays blocked.
Disconnect does not cancel orders or merchant subscriptions or undo an already submitted purchase.

## Real Link persistence and recovery

Grants use `(issuer, principal ID)` from verified Linq authentication. They survive conversation
changes and restarts and cannot be selected through model-supplied IDs. Different senders have
separate grants, even for the same operator. A web conversation or second phone is not paired
automatically with an existing wallet.

Tokens, PKCE verifiers, and framework callback capabilities are encrypted with AES-256-GCM and
bound to their owner. Only hashes of state and callback URLs appear outside encrypted records.
Refresh happens sixty seconds before expiry. PostgreSQL advisory locks serialize refresh,
connection replacement, and disconnect per sender. Each native Link request rechecks the grant
even when Eve has cached a bearer within the current execution step. Use a direct connection or
session-mode pooler; transaction-mode poolers are incompatible with these session advisory locks.

Codes and refresh tokens are single use. Bell durably records an exchange as in progress before
sending it. A lost response or process failure can require fresh consent instead of retrying
the same exchange. A Link 401 invalidates the stored bearer and starts a new consent flow. New
attempts supersede earlier attempts for that sender. Before requesting new consent, Bell revokes
any previously stored grant so it cannot be left authorized after wallet replacement. After a
failed refresh, ask Bell to reconnect. If revoking the old grant fails during reconnect or
disconnect, retry **“Disconnect my Link wallet”** successfully before reconnecting.
An identical callback can be redelivered if a phone loses the redirect response; a completed
exchange cannot be repeated and changed callback parameters are rejected.

Database downtime, a wrong encryption key, or missing configuration fails closed. User-facing
errors exclude provider bodies, tokens, and database credentials. The server emits a sanitized
`link.error` diagnostic with one of these reasons:

| Reason | Operator action |
| --- | --- |
| `missing_configuration` / `invalid_configuration` | Fix the named environment variable; values are never logged. |
| `database_migration_required` | Apply the migration to the configured database. |
| `database_unavailable` | Check database connectivity and credentials. |
| `credentials_unreadable` | Restore the encryption key used for existing grants. |
| `unexpected_error` | Check deployment health and reproduce with the regression tests; raw errors are withheld. |

New instances need the same database and encryption key.

Expired attempts cannot authorize a connection. Periodically remove old records, including
encrypted verifier data from abandoned attempts:

```sql
DELETE FROM bell_link_oauth_attempts WHERE expires_at < now() - interval '1 day';
```

PostgreSQL here stores Link state and browser privacy guards. Eve still needs durable workflow storage to resume
parked turns after host replacement, and Bell's Context metadata and optional local vault files
need their documented storage. This change does not make the rest of Bell ready for arbitrary multi-instance hosting
or unrelated users.

## Transcript boundary

OAuth tokens and client secrets never enter tool arguments or conversational output. Bell
overrides the native extension's credential retrieval: the tool accepts only a spend-request ID,
and every spend-request result is projected to an explicit metadata allowlist before Eve can
persist it. Card and payment-token fields, including unexpected provider fields, are discarded.
The separate `link__checkout` tool retrieves credentials only inside its server-side operation and
returns an enumerated status. The mounted purchase skill uses this tool for approved Link payment.

Wallet metadata and shipping addresses are still personal data. Restrict transcripts to the
trusted operator and apply your host's retention/deletion policy. Disabled Browserbase logging
does not disable Eve event persistence. Upgrading does not remove credentials from transcripts
created by older versions; delete those transcripts and their backups under your retention policy.

## Verify

`pnpm check` runs mock provider tests. Set `TEST_LINK_DATABASE_URL` to a disposable
PostgreSQL database to include persistence tests. The suite creates and drops a unique schema;
it never uses `DATABASE_URL` or calls Link. CI provides PostgreSQL automatically. Tests cover
encryption, identity isolation, callbacks, restart recovery, concurrent refresh, revocation,
spend-request path validation, the metadata-only payment boundary, and persistent browser quarantine.
Set `TEST_LINK_BROWSER=1` and, if needed, `TEST_CHROME_PATH` to include real Chrome checkout tests
against intercepted synthetic merchant pages. Those tests submit fixture forms, not real purchases.

For an operator-run live smoke test, text “List my Link payment methods,” complete consent, and
verify the response arrives in the same chat. Send a follow-up to confirm grant reuse, then
disconnect and confirm the next request needs consent. This uses real Linq and Link services.
Live checkout needs a separately specified merchant, item, and budget; automated tests and the
wallet smoke test do not submit purchases.

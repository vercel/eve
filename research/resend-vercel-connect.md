---
issue: TBD
status: proposed
last_updated: "2026-07-31"
---

# Resend email setup with a generic Connect API key

## Recommendation

Implement the initial Resend channel without a native `resend` Connect type.
Use the existing generic `api-key` connector for the account credential, let
eve setup create the Resend webhook on the user's behalf, and keep direct
Resend signature verification in the official Chat SDK adapter.

```text
Resend ── Svix-signed email.received ──> eve /eve/v1/resend
                                             │
                                             │ app token
                                             v
                              generic Connect api-key connector
                                             │
                                             v
                                         Resend API
```

This provides guided setup and Connect-managed outbound credentials now without
competing with the planned Marketplace Native→Connect bridge. The bridge can
later replace credential acquisition while the channel and webhook behavior
remain unchanged.

## Ownership

- The generic Connect connector represents the Resend account API credential.
  It stores one full-access `re_…` value as an app-scoped API-key token for
  `api.resend.com`.
- Resend calls the eve deployment directly. The official
  `@resend/chat-sdk-adapter` owns Svix verification, received-email fetching,
  attachments, threading, and delivery.
- The Vercel project stores `RESEND_WEBHOOK_SECRET`. Setup creates and updates
  it; it is not stored in the generic connector.
- eve owns setup orchestration and generated channel code, not Resend account,
  billing, domain, or DNS lifecycle.

Recipient filtering stays in authored Chat SDK handlers. Resend receiving
webhooks are account-wide and include the destination in the event payload.

## Authoring result

Setup writes `agent/channels/resend.ts` using the existing
`chatSdkChannel`. The exact helper naming may follow the implementation landed
in `@vercel/connect`, but the generated contract should be equivalent to:

```ts
import { createMemoryState } from "@chat-adapter/state-memory";
import { createResendAdapter } from "@resend/chat-sdk-adapter";
import { getToken } from "@vercel/connect";
import type { Message, Thread } from "chat";
import { chatSdkChannel, messageToUserContent } from "eve/channels/chat-sdk";

const connector = "api-key/resend";

export const { bot, channel, send } = chatSdkChannel({
  userName: "Email Agent",
  adapters: {
    resend: createResendAdapter({
      apiKey: () => getToken(connector, { subject: { type: "app" } }),
      fromAddress: "agent@example.com",
      fromName: "Email Agent",
    }),
  },
  state: createMemoryState(),
  streaming: false,
});

bot.onNewMention(async (thread: Thread, message: Message) => {
  await thread.subscribe();
  await send(messageToUserContent(message), { thread });
});

bot.onSubscribedMessage(async (thread: Thread, message: Message) => {
  await send(messageToUserContent(message), { thread });
});

export default channel;
```

Use a durable Chat SDK state adapter in production. Memory state is acceptable
only as the generated local-development default.

## Guided setup flow

Register a `resend` setup integration in eve's setup integration registry,
following Discord for orchestration and Photon for Connect/portable choices.
The Connect path should:

1. Require an authenticated Vercel CLI and ensure the directory is linked to a
   Vercel project.
2. Explain that the key needs full access because setup manages webhooks and the
   adapter fetches received-email contents. Collect the key with a sensitive
   prompt and trim it once.
3. Collect `fromAddress` and optional `fromName`. These are application delivery
   settings, not connector metadata.
4. Validate the key with a bounded Resend request such as `GET /webhooks`. Map
   authentication and provider failures to actionable errors without including
   the key.
5. Create or reuse a generic Connect API-key connector:
   - `type: "api-key"`;
   - `service: "api.resend.com"`;
   - one unscoped value containing the full-access key;
   - deterministic UID derived from the project/agent, not a hard-coded global
     UID.
     Send secret JSON through stdin (`--data @-`), never argv.
6. Attach the connector to the linked project for production. Do not register a
   Connect trigger destination; Resend calls eve directly.
7. Add `chat`, `@resend/chat-sdk-adapter`, `@chat-adapter/state-memory`, and
   `@vercel/connect`; scaffold the channel with the exact returned connector
   UID.
8. Deploy production so the canonical endpoint exists at
   `https://<production-domain>/eve/v1/resend`.
9. Reconcile the Resend webhook for that exact endpoint:
   - list webhooks;
   - leave unrelated endpoints untouched;
   - reuse an exact match when its signing secret is available;
   - otherwise create the replacement before deleting the old exact match;
   - subscribe only to `email.received`.
10. Save the returned signing secret as production
    `RESEND_WEBHOOK_SECRET` through Vercel CLI stdin, then redeploy.
11. Print the endpoint, sending address, receiving-domain guidance, and a
    send/reply smoke test.

If a failure occurs after connector creation, return recovery commands including
the connector UID. Do not imply that persisted effects were rolled back.

Offer a portable path that scaffolds the same channel with
`RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET` environment variables and explains
manual webhook setup.

## Idempotency and safety

A rerun must not create duplicate connectors or webhooks. Resolve an existing
connector by deterministic UID and verify it is an API-key connector for
`api.resend.com` before reuse. Never overwrite an incompatible connector.

Webhook reconciliation must compare normalized exact endpoint URLs and never
delete manually created or unrelated webhooks. If a new webhook is created and
saving its secret fails, delete that new webhook best-effort while preserving
any previously working endpoint. Log only connector ID, webhook ID, and endpoint
host/path—not credentials or signing secrets.

The generated runtime resolves the API key lazily. Concurrent resolutions
should share the Connect SDK's normal token caching, and a failed resolution
must be retryable.

## Required PR stack

1. **Resend Chat SDK adapter** (`resend/resend-chat-sdk`): accept
   `apiKey: string | () => Promise<string>` and resolve it for outbound sends
   and received-email fetches. Preserve the existing `webhookSecret` path; no
   custom Connect webhook verifier is needed in this design.
2. **`@vercel/connect`** (`vercel/vercel`): optionally add a small typed
   Resend/API-key config helper. Direct `getToken` is sufficient if the helper
   would only rename arguments. Add tests for app subject, lazy resolution, and
   exports.
3. **eve** (`vercel/eve`): registry entry, setup coordinator, Resend API helper,
   generic connector provisioning/attachment, webhook reconciliation,
   scaffolding, package updates, tests, docs, and changeset.

No `vercel/api` or Front change is required for the initial implementation;
the generic API-key connector and existing Connect UI remain unchanged. The
native Resend connector draft stack should not be a dependency of this plan.

## Tests

At minimum cover:

- whitespace-padded key is normalized once and the same value reaches
  validation, connector creation, and webhook setup;
- secrets are sent on stdin and never argv/log output;
- connector create versus deterministic-UID reuse;
- incompatible existing connector rejection;
- webhook exact-match reuse, create, replacement ordering, and compensation;
- unrelated webhooks are untouched;
- env write and redeploy ordering;
- partial-failure recovery instructions;
- generated source contains the returned UID and typechecks;
- cancellation and unauthenticated Vercel behavior;
- portable setup behavior;
- packed eve package setup, `tsc --noEmit`, and `eve build` in a fresh fixture.

## Future Marketplace bridge

Do not read a Marketplace-provisioned API key back through project environment
variables or copy it into Connect. The Native→Connect bridge under design lets
the Marketplace provider create a confidential OAuth client and user-backed
resource authorization, then supplies access/refresh tokens to Connect's app
subject path.

When that bridge ships, guided setup should offer Marketplace installation or
resource selection ahead of the manual key path. The eventual managed flow may
use a Marketplace-origin generic OAuth connector or a provider-specific trigger
capability; coordinate that ownership before moving direct webhook verification
into Connect. The manual generic API-key path remains useful for Resend accounts
outside Marketplace.

## Sources

- [eve + Resend guide](https://vercel.com/kb/guide/eve-agent-with-resend)
- [eve Chat SDK channel](https://eve.dev/docs/channels/chat-sdk)
- [Resend Chat SDK adapter](https://chat-sdk.dev/adapters/vendor-official/resend)
- [Receiving email](https://resend.com/docs/dashboard/receiving/introduction)
- [Creating webhooks](https://resend.com/docs/api-reference/webhooks/create-webhook)
- [Webhook verification](https://resend.com/docs/webhooks/verify-webhooks-requests)
- [Vercel Marketplace integration](https://resend.com/docs/guides/vercel-marketplace-integration)
- [Native→Connect bridge](https://app.notion.com/p/vercel/Native-Connect-bridge-3ace06b059c480508774c4813e1c4fe4)

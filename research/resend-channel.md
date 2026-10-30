---
issue: TBD
status: proposed
last_updated: "2026-10-30"
---

# Resend email channel

> **AI status:** Written by AI; human review pending.

## Problem

Email reaches eve today only through the Chat SDK channel plus `@resend/chat-sdk-adapter`. That
path needs a durable Chat SDK state store, a hand-made Resend webhook, and a per-webhook signing
secret in the project. Vercel Connect now registers Resend webhooks, verifies them, and forwards
each event with Vercel OIDC, which removes the webhook and secret steps, but the adapter cannot
accept a Connect-forwarded request.

## Proposal

A first-class `eve/channels/resend` channel, built like the Twilio channel: `defineChannel`, no
runtime dependency, and plain `fetch` calls to the Resend API.

```ts title="agent/channels/resend.ts"
import { connectResendCredentials } from "@vercel/connect/eve";
import { resendChannel } from "eve/channels/resend";

export default resendChannel({
  allowFrom: "@acme.com",
  credentials: connectResendCredentials("resend/my-agent"),
  fromAddress: "agent@acme.com",
});
```

`credentials` has the same `{ apiKey, webhookVerifier }` shape as the Linq channel, so the Connect
helper returns it directly. Without Connect, pass `webhookSecret` and the channel verifies
Resend's Svix signature itself.

## Semantics

```text
Resend ──email.received──▶ Connect (verify, OIDC) ──▶ POST /eve/v1/resend
                                                      │ verify, allowFrom on payload sender
                                                      ▼
                                    GET /emails/receiving/:id (body, headers, DMARC)
                                                      │ allowFrom again, onEmail
                                                      ▼
                       from("<sender>:<root Message-ID>").send(body, { state, idempotencyKey })
                                                      │
                     reply ◀── POST /emails (Re: subject, In-Reply-To, References)
```

- **Verification.** `webhookVerifier` wins, then `webhookSecret`. With neither, only Vercel OIDC
  from the same project and environment is accepted, matching Linq.
- **Access.** `allowFrom` is required, like Twilio. Entries are addresses, `@domain`, or `"*"`. The
  default `onEmail` drops email whose DMARC result is `fail`.
- **Threads.** A session is keyed on the sender address and the thread's root `Message-ID`, the
  first `References` entry. Keying on the sender stops someone who learns a `Message-ID` from
  joining another person's thread. Our replies never need their own `Message-ID`: mail clients
  carry the root forward in `References`.
- **Content.** The text part, or HTML converted to Markdown, minus a trailing quoted reply. A
  `<resend_context>` block carries sender, recipients, subject, and attachment names.
- **Replies.** Plain-text email through `surfaceEvents`, so approvals, questions, and sign-ins
  work as on Twilio: numbered options answered by reply.
- **Retries.** `idempotencyKey: resend:<email id>` deduplicates redelivered events.

## Out of scope for the first cut

- Guided setup through `eve add channel/resend`.
- Attachment download, HTML replies, and Resend Inboxes (`inbox.email.received`).
- Proactive `receive()`. A first outbound email has no root the channel knows until the reply.

## Open questions

- Should the default `onEmail` also require DKIM or SPF `pass`, not only reject DMARC `fail`?
- Should replies render Markdown to HTML? That needs a sanitizer story for model output.

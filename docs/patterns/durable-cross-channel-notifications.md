---
title: "Durable cross-channel notifications"
description: "Send a notification to another platform without starting an agent turn, using an application-owned outbox for retries and deduplication."
---

`ctx.to(channel, target).send(...)` hands a message to another channel and starts or resumes an agent session there. eve does not currently provide a direct cross-channel message queue or provider outbox. To post a notification without a model call, use the destination platform's API instead. When the notification must survive a crash, record the intent in an application-owned outbox before attempting delivery.

An application-owned outbox is the current pattern for durable provider notifications. It provides at-least-once processing. It does not by itself guarantee exactly-once delivery: if the provider accepts a request but the response is lost, the dispatcher cannot know whether to retry. Use a provider idempotency key when one is available. Otherwise, make duplicates harmless or reconcile the destination before retrying an ambiguous request.

This example posts to Slack and requires `SLACK_REVIEW_CHANNEL_ID` and `SLACK_BOT_TOKEN`. If your channel uses Vercel Connect, pass the connector's `botToken` resolver to `callSlackApi` instead.

## Record the notification intent

Attach a platform-specific side effect to that platform's channel rather than filtering a global hook. This GitHub channel records one Slack notification per completed GitHub turn:

```ts title="agent/channels/github.ts"
import { githubChannel } from "eve/channels/github";

import { notificationOutbox } from "../lib/notification-outbox";

export default githubChannel({
  botName: process.env.GITHUB_APP_SLUG,
  events: {
    async "turn.completed"(event, channel, ctx) {
      await notificationOutbox.enqueue({
        key: `github-review:${ctx.session.id}:${event.turnId}`,
        destination: {
          channelId: process.env.SLACK_REVIEW_CHANNEL_ID!,
          provider: "slack",
        },
        message: `PR review completed for ${channel.repository.fullName}.`,
      });
    },
  },
});
```

`enqueue` must enforce a unique constraint on `key`, for example with `INSERT ... ON CONFLICT DO NOTHING`. A durable step can re-run after an interruption, and channel event handlers are at least once. The stable key prevents those attempts from creating multiple outbox rows.

A channel's `events` handlers run only for sessions owned by that channel. On built-in channels, an authored handler replaces the built-in handler for the same event key; use an event without a built-in handler or reproduce behavior you intend to replace. See [Hooks](../guides/hooks#scope-side-effects-to-a-channel) for the channel-scoping rules.

## Claim and deliver pending rows

Use one handler-form schedule as the dispatcher. Claim rows with a lease, call the provider API, then mark each row complete:

```ts title="agent/schedules/notification-outbox.ts"
import { callSlackApi } from "eve/channels/slack";
import { defineSchedule } from "eve/schedules";

import { notificationOutbox } from "../lib/notification-outbox";

export default defineSchedule({
  cron: "* * * * *",
  run({ waitUntil }) {
    waitUntil(
      (async () => {
        const notifications = await notificationOutbox.claim({
          limit: 25,
          leaseForMs: 5 * 60_000,
        });

        await Promise.all(
          notifications.map(async (notification) => {
            try {
              const response = await callSlackApi({
                botToken: undefined,
                operation: "chat.postMessage",
                body: {
                  channel: notification.destination.channelId,
                  text: notification.message,
                },
              });
              if (!response.ok) throw new Error(String(response.error));

              await notificationOutbox.complete(notification, {
                providerMessageId: String(response.ts),
              });
            } catch (error) {
              await notificationOutbox.release(notification, {
                error,
                retryAt: new Date(Date.now() + 5 * 60_000),
              });
            }
          }),
        );
      })(),
    );
  },
});
```

`callSlackApi` falls back to `SLACK_BOT_TOKEN` when `botToken` is `undefined`.

The storage adapter is application code. It needs these semantics:

- `enqueue` inserts once by the stable operation key.
- `claim` atomically leases pending rows so overlapping dispatchers do not send the same row concurrently.
- `complete` records the provider message ID and marks the row delivered.
- `release` records the error and makes the row eligible after `retryAt`.
- Expired leases return to the pending set.

## Handle ambiguous delivery

An error that proves the provider did not accept the request is safe to retry. A timeout, connection reset, or crash after the request leaves your process is ambiguous. The provider may have accepted the notification even though the dispatcher did not record completion.

Handle that window in this order:

1. Pass the outbox key through the provider's idempotency-key option when the API supports one.
2. Otherwise, store a stable marker in provider metadata and query for it before retrying, when the provider offers a reliable lookup.
3. If neither is available, design the notification so a duplicate is safe and visible as the same logical operation.

Do not mark an ambiguous row complete merely to suppress a duplicate; that can lose a notification the provider never accepted. Do not describe an outbox as exactly once unless the provider's contract closes this ambiguity window.

If the destination should run the agent rather than receive a notification, use [`ctx.to(...).send(...)`](../channels/custom#cross-channel-hand-off) instead. That path creates or resumes a durable session and invokes the model.

---
title: "Durable cross-channel notifications"
description: "Send a notification to another platform without starting an agent turn, using an application-owned outbox for retries and deduplication."
---

A cross-channel notification posts to another platform's API without starting an agent turn. Your application first saves the notification in an outbox table, so the notification survives a crash. eve has no built-in queue for these messages. `ctx.to(channel, target).send(...)` starts or resumes an agent session on the destination instead.

The outbox sends each notification at least once, not exactly once. If the provider accepts a request but the response is lost, the dispatcher cannot know whether to retry. Use a provider idempotency key when one is available. Otherwise, make duplicates harmless or reconcile the destination before retrying an ambiguous request.

This example posts to Slack and requires `SLACK_REVIEW_CHANNEL_ID` and `SLACK_BOT_TOKEN`. If your channel uses Vercel Connect, pass the connector's `botToken` resolver to `callSlackApi` instead.

## Record the notification intent

Put a side effect for one platform on that platform's channel, not in a global hook. This GitHub channel saves one Slack notification for each completed GitHub turn:

```ts title="agent/channels/github.ts"
import { githubChannel } from "eve/channels/github";

import { notificationOutbox } from "../lib/notification-outbox";

export default githubChannel({
  botName: process.env.GITHUB_APP_SLUG,
  events: {
    async "turn.settled"(event, ctx) {
      if (event.data.outcome !== "completed") return;
      await notificationOutbox.enqueue({
        key: `github-review:${ctx.session.id}:${event.data.turnId}`,
        destination: {
          channelId: process.env.SLACK_REVIEW_CHANNEL_ID!,
          provider: "slack",
        },
        message: `PR review completed for ${ctx.channel.repository.fullName}.`,
      });
    },
  },
});
```

`enqueue` must enforce a unique constraint on `key`, for example with `INSERT ... ON CONFLICT DO NOTHING`, because channel event handlers run at least once.

A channel's `events` handlers run only for sessions that started on that channel. On built-in channels, an authored handler replaces the built-in handler for the same event key. Use an event without a built-in handler, or reproduce the behavior you replace. See [Hooks](../guides/hooks#scope-side-effects-to-a-channel) for the rules.

## Claim and deliver pending rows

Use one schedule with a `run` handler to send the notifications. Claim rows with a lease, call the provider API, then mark each row complete:

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
                botToken: undefined, // falls back to SLACK_BOT_TOKEN
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

The storage adapter is your application code. It must keep these rules:

- `enqueue` inserts each `key` once.
- `claim` atomically leases pending rows, so overlapping schedule runs do not send the same row at the same time.
- `complete` saves the provider message ID and marks the row sent.
- `release` saves the error and makes the row eligible after `retryAt`.
- Expired leases return to the pending set.

## Handle ambiguous delivery

An error that proves the provider did not accept the request is safe to retry. A timeout, connection reset, or crash after the request leaves your process is ambiguous, because the provider may have accepted it. Handle that case in this order:

1. Pass the outbox key through the provider's idempotency-key option when the API supports one.
2. Otherwise, store a stable marker in provider metadata and query for it before retrying, when the provider offers a reliable lookup.
3. If neither is available, design the notification so a duplicate is safe and visible as the same logical operation.

Do not mark an ambiguous row complete only to prevent a duplicate. That can lose a notification the provider never accepted.

If the destination should run the agent rather than receive a notification, use [`ctx.to(...).send(...)`](../channels/custom#cross-channel-hand-off), which creates or resumes a session and runs the model.

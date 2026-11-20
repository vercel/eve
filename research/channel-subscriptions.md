---
issue: https://github.com/vercel/eve/pull/6638
status: implemented
last_updated: "2026-11-20"
---

# Channel event subscriptions

> **AI status:** Written entirely by AI; human review pending.

A session can already wait on a person, but not on a build, a pull request check or a webhook.
MCP connections can do it through `experimental.events`. Channels could not, so an agent that
received GitHub webhooks could only react to them by opening a new session.

A channel now lets a session subscribe to future events from it. The model calls
`eve__subscribe` with a source, an event name and a scope. eve holds the subscription in a
durable workflow, and each matching occurrence is queued onto the subscribing session as a new
turn.

## Authoring API

The API is experimental, like MCP `experimental.events`, and can change in any release.

```ts
defineChannel({
  experimental: {
    subscriptions: {
      onEvent: ({ auth, event, subscription }) =>
        auth === null ? null : `Build ${event.id} ${event.name} for ${subscription.input.project}.`,
    },
  },
  routes: [
    POST("/builds", async (request, { experimental }) => {
      const build = await request.json();
      await experimental.subscriptions.emit(
        `build.${build.status}`,
        { project: build.project },
        { id: build.id, data: build },
      );
      return Response.json({ ok: true });
    }),
  ],
});
```

- `onEvent` runs once per subscription for each occurrence, as the subscriber. It returns the
  message to queue, or `null` to drop the occurrence for that subscription. Any other value
  fails the delivery.
- `emit` returns `true` when at least one subscription holds the occurrence and `false` when
  nobody is subscribed, so a webhook with no subscribers still succeeds. It throws when the host
  cannot hold subscriptions, and `githubChannel` throws for an event name eve cannot deliver.
- `githubChannel` takes the same `experimental.subscriptions.onEvent` and exports
  `describeGitHubEvent(event)` for the default message. It also takes
  `experimental.subscriptions.onSubscription`.

## Tools

The root agent gets three tools: `eve__subscribe`, `eve__subscription_get` and
`eve__subscription_stop`. They use the `eve__` prefix because eve reserves it, so an authored
tool cannot replace them. They are framework tools and subagents do not see them, because a
subagent has no session of its own to receive events.

One `source` names either a channel or a connection. A channel and a connection that both offer
subscriptions and share a name cannot be told apart, so eve reports an error when it builds the
tool set.

## Delivery

- A subscription is a durable workflow keyed by source, event name and canonical scope. Each key
  remembers its last 256 event IDs, so a redelivered webhook reaches each subscriber once.
- A delivery is queued behind a running turn and runs under the `auth` the session held when it
  subscribed, never the identity of the caller of the route.
- When the subscribing session has ended, the next delivery retires the subscription.
- A join that arrives while the last member of a key is leaving is not acknowledged. The joiner
  sees its wait end, and `joinKeyStep` joins again with a new acknowledgement ID, which starts a
  new run for the key. Tests cover both halves.

## Authorization

Without `onSubscription`, any session of the agent can subscribe to any scope a channel's
routes emit, and `onEvent` is the only check. For GitHub that means any session can watch any
repository the App is installed on.

`onSubscription` is the hook for who may subscribe. It runs inside `eve__subscribe`, as the
session, with `auth` and the requested channel, event and scope. It throws to deny, and the
message becomes the tool's error. It can return `{ input }` to subscribe to a narrower scope,
which eve checks against the channel's input schema again. It runs once, at subscribe time;
`onEvent` stays the formatter and the check at each delivery.

## Not in this change

- One authoring contract for MCP and channel subscriptions, and renaming MCP
  `experimental.events` to `experimental.subscriptions`.
- Per-event schemas for the scope and the data.
- Emitting from tools, schedules and hooks, and delivery to something other than a session.

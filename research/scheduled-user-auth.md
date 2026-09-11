---
issue: TBD
last_updated: "2026-06-28"
status: proposed
---

# Scheduled user auth and connection authorization

## Summary

User-scoped connection auth already has the right durable primitive in eve:
tools and MCP connections resolve an auth provider, throw
`ConnectionAuthorizationRequiredError` when a user must consent, emit
`authorization.required`, park the session, and resume through the framework
callback route.

Scheduled runs should not introduce a parallel auth-key or preflight system.
They should make the lower-level session facts explicit:

- which principal the scheduled work runs as;
- which channel session can render `authorization.required`;
- where the channel should deliver the scheduled turn.

Once a scheduled run is inside a normal channel session with a real user
principal, existing tool and connection auth can do the rest.

## Current behavior

Markdown schedules run in task mode as the schedule app principal:

```ts
import { defineSchedule } from "eve/schedules";

export default defineSchedule({
  cron: "*/5 * * * *",
  markdown: "Pull open Linear issues and POST a summary to the metrics endpoint.",
});
```

This mode has no channel, no human input capability, and no user principal. It
runs to completion or fails. If a user-scoped connection is invoked, principal
resolution should fail with `principal_required` because there is no user whose
OAuth grant can be used.

Handler schedules can hand work to a channel:

```ts
import { defineSchedule } from "eve/schedules";
import slack from "../channels/slack.js";

export default defineSchedule({
  cron: "* * * * *",
  async run({ receive, waitUntil, appAuth }) {
    waitUntil(
      receive(slack, {
        message: "Check for new critical alerts. Report only when there are any.",
        target: { channelId: "C0123ABC" },
        auth: appAuth,
      }),
    );
  },
});
```

This starts a normal durable channel session, so it can park. However, passing
`appAuth` still makes the session app/runtime-scoped. User-scoped connection
auth still fails because the active session is not a user.

A handler schedule can already express the desired runtime semantics by passing
a real user auth context to `receive`:

```ts
import { defineSchedule } from "eve/schedules";
import slack from "../channels/slack.js";

const userAuth = {
  authenticator: "slack-webhook",
  issuer: "slack:T123",
  principalId: "slack:T123:U123",
  principalType: "user",
  attributes: {
    author_type: "user",
    channel_id: "D123",
    team_id: "T123",
    thread_ts: "",
    user_id: "U123",
  },
};

export default defineSchedule({
  cron: "0 9 * * 1-5",
  async run({ receive, waitUntil }) {
    waitUntil(
      receive(slack, {
        message: "Summarize my Notion meeting notes.",
        target: { channelId: "D123" },
        auth: userAuth,
      }),
    );
  },
});
```

If a Notion MCP connection then uses `auth: connect("notion/myagent")`, the
connection calls `getToken`, Vercel Connect reports that the user must consent,
eve emits `authorization.required`, Slack privately delivers the challenge, and
the parked turn resumes after the callback.

## Design goals

- Reuse existing tool and connection auth.
- Keep provider selection at the tool or connection, not on the schedule.
- Avoid schedule-level auth keys such as `ensureAuthorized: ["notion"]`.
- Make user-owned scheduled work explicit about principal and delivery surface.
- Preserve markdown schedule simplicity for app-owned fire-and-forget jobs.
- Keep channel-specific notification behavior in the channel event handlers.

## Non-goals

- Do not add a second authorization challenge table or schedule-owned OAuth
  lifecycle.
- Do not make schedules inspect MCP connection names, tool auth keys, or Vercel
  Connect connector ids.
- Do not use CIBA or device flow as the core durability mechanism. A provider
  may surface a device code in the challenge, but the durable primitive remains
  eve's session park/resume path.
- Do not make app-scoped interactive OAuth implicit. App-scoped Connect auth
  remains non-interactive unless a separate explicit design addresses the
  product and security questions.

## Runtime model

The auth lifecycle should stay identical across interactive sessions and
scheduled user sessions:

```text
schedule fires
  -> schedule starts or resumes a channel session with auth.current = user
  -> model invokes a tool or MCP connection
  -> provider getToken runs for that user principal
  -> provider throws ConnectionAuthorizationRequiredError
  -> harness emits authorization.required and parks the session
  -> channel renders the challenge privately to the user
  -> provider callback hits eve's connection callback route
  -> parked session resumes and retries the tool or connection
```

No schedule code knows which provider needed auth. It only supplied the user
principal and the channel sink.

## Authoring API

### Existing low-level shape

The current handler shape is already the primitive:

```ts
export default defineSchedule({
  cron: "0 9 * * 1-5",
  async run({ receive, waitUntil }) {
    waitUntil(
      receive(slack, {
        message: "Summarize my Notion meeting notes.",
        target: { channelId: "D123" },
        auth: userAuth,
      }),
    );
  },
});
```

This should be documented as the escape hatch and treated as the semantic
baseline for any sugar.

### Proposed markdown delivery sugar

Add a channel-delivery option for markdown schedules. This is syntax sugar over
the handler above:

```ts
import { defineSchedule } from "eve/schedules";
import slack from "../channels/slack.js";
import { userAuth } from "../lib/users.js";

export default defineSchedule({
  cron: "0 9 * * 1-5",
  markdown: "Summarize my Notion meeting notes.",
  deliver: {
    channel: slack,
    target: { channelId: "D123" },
    auth: userAuth,
  },
});
```

Lowering:

```ts
async run({ receive, waitUntil }) {
  waitUntil(
    receive(deliver.channel, {
      message: markdown,
      target: deliver.target,
      auth: deliver.auth,
    }),
  );
}
```

This keeps the schedule API at the session level: channel, target, and auth.
It does not mention Notion, Linear, a connection name, or an auth key.

### App-owned markdown remains unchanged

Plain markdown remains app-owned task mode:

```ts
export default defineSchedule({
  cron: "*/5 * * * *",
  markdown: "Sync open Linear issues to the metrics endpoint.",
});
```

Use this when the called connections are unauthenticated or app-scoped:

```ts
connect({ connector: "linear/myagent", principalType: "app" });
```

User-scoped auth in this mode continues to fail fast with `principal_required`.
That failure is useful because there is no safe user identity or notification
surface to bind consent to.

### Channel principal helpers

The low-level API needs a reasonable way to build the `SessionAuthContext` a
channel would normally derive from inbound traffic. Slack already has the
internal shape needed for its default authorization prompt handler:

- `authenticator: "slack-webhook"`;
- `principalType: "user"`;
- `issuer: "slack:<teamId>"`;
- `attributes.user_id`, plus team and channel metadata.

Expose channel-owned helpers so authors do not hand-roll these details:

```ts
import { slackUserAuth } from "eve/channels/slack";

const userAuth = slackUserAuth({
  channelId: "D123",
  teamId: "T123",
  threadTs: "",
  userId: "U123",
});
```

The helper is intentionally a principal builder, not a connection auth provider.
The connection or inline tool still owns `connect("notion/myagent")`.

## Why not schedule auth keys

Tool auth moved away from requiring authors to name an auth key before they
could resolve a credential. The tool can receive a provider object and call:

```ts
const { token } = await ctx.getToken(connect("github/myagent"));
```

Schedules should follow the same direction. A schedule-level shape like this is
the wrong abstraction:

```ts
export default defineSchedule({
  cron: "0 9 * * 1-5",
  ensureAuthorized: ["notion"],
  markdown: "Summarize my Notion meeting notes.",
});
```

It couples schedule authoring to connection names and encourages auth preflight
that can drift from actual tool use. The lower-level schedule contract should
be "start this channel session as this principal." The first tool or connection
that truly needs auth can throw the normal auth-required signal.

If a future preflight is needed, it should accept provider values rather than
string keys, and it should still run inside the channel session:

```ts
// Deferred. Not part of the MVP.
preflight: [connect("notion/myagent")];
```

## Implementation plan

### 1. Lock current semantics

Add tests that make the existing boundaries explicit:

- markdown schedules run with `SCHEDULE_APP_AUTH`;
- markdown schedules cannot park for human input or connection OAuth;
- handler schedules passing `appAuth` start a channel session as the app
  principal;
- handler schedules passing a user `SessionAuthContext` start a channel session
  whose `auth.current` is that user;
- user-scoped connection auth invoked without a user principal fails with
  `reason: "principal_required"`.

These tests document the contract before adding sugar.

### 2. Export channel principal builders

Expose a Slack helper that returns the same auth shape Slack inbound traffic
uses today. Its output should be accepted anywhere a `SessionAuthContext` is
accepted:

```ts
slackUserAuth({
  channelId: string;
  fullName?: string;
  teamId?: string | null;
  threadTs: string;
  userId: string;
  userName?: string;
}): SessionAuthContext
```

The helper can wrap the existing Slack auth-context builder. Other channels can
add equivalent helpers when they support proactive user-owned scheduled work.

### 3. Add `deliver` to markdown schedule definitions

Extend the TypeScript schedule definition union:

```ts
type ScheduleDefinition =
  | {
      cron: string;
      markdown: string;
      deliver?: ScheduleDeliveryDefinition;
      run?: never;
    }
  | {
      cron: string;
      markdown?: never;
      run: ScheduleRunHandler;
      deliver?: never;
    };

interface ScheduleDeliveryDefinition<TChannel = unknown> {
  channel: TChannel;
  target: InferReceiveTarget<TChannel>;
  auth: SessionAuthContext | null;
}
```

`deliver` is legal only with `markdown`. Handler schedules already have
`receive`.

### 4. Lower `markdown + deliver` through the existing dispatcher

Update schedule loading and dispatch so a markdown schedule with `deliver`
calls the same `receive` path handler schedules use. It should not use
`SCHEDULE_ADAPTER` task mode.

The dev dispatch route should continue to return the child session id from
`receive`, just like handler schedules do today.

### 5. Keep auth-required handling in the channel

No new schedule-specific auth event is needed. The existing harness behavior
should emit `authorization.required`, and the target channel's event handler
should render it.

For Slack, verify that proactive user-owned sessions set enough state for the
default handler to deliver the challenge privately:

- `ctx.session.auth.current` resolves to a Slack user id;
- the target channel and thread are known;
- public status remains link-free;
- the OAuth URL and device code stay ephemeral or DM-only.

### 6. Add integration coverage

Add a focused integration test with a fake interactive auth provider:

1. Schedule dispatches `markdown + deliver` into a fake channel with
   `requestInput` capability.
2. A tool or connection throws `ConnectionAuthorizationRequiredError`.
3. The stream emits `authorization.required`.
4. The session parks with pending authorization state.
5. A callback resumes the session.
6. The provider's `completeAuthorization` runs and the original work retries.

Add a sibling test showing that the same provider in plain markdown task mode
fails with `principal_required` or an auth-callback-unavailable failure rather
than parking invisibly.

### 7. Update docs

Update schedules docs with three explicit examples:

- app-owned markdown schedule;
- app-owned handler schedule using `appAuth`;
- user-owned scheduled channel session using `deliver` or the low-level handler
  `receive` shape.

Update connection auth troubleshooting to point scheduled user-owned work at
channel delivery rather than provider keys or app-scoped auth.

### 8. Changeset

If this proposal graduates into API changes, include a patch changeset for the
published `eve` package. The research-only draft PR does not need one.

## Open questions

- Should the markdown sugar be named `deliver`, `receive`, `session`, or
  `channel`? `deliver` describes the behavior without implying an inbound
  request, but the final name should match the rest of the public API.
- Should `deliver.auth` accept a lazy function so application-managed dynamic
  schedules can resolve the latest principal metadata at fire time?
- Should Slack expose a helper for DM targets, or should authors keep passing
  `{ channelId }` after opening or storing the DM channel id themselves?
- Should a proactive public-channel user schedule be allowed, where auth prompts
  are ephemeral to the user and public status is link-free, or should
  user-owned schedules require a DM target by default?
- How should the compiler validate `deliver.channel` references when the target
  channel is not registered in `agent/channels/`? Handler schedules currently
  catch this at dispatch through `receive`.

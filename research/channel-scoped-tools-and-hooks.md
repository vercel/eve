---
issue: "None (long-standing request; related to #351; follows the Slack renderer split in PR #4028)"
status: proposed
last_updated: "2026-09-30"
---

# Channel-scoped tools and hooks

## Summary

An agent with several channels gives every session the same tools and runs every hook for every session. Nothing in a tool knows which channel it serves. The standard example is a `post_to_slack` tool: it should exist only in Slack sessions, and it should post with the Slack channel's own credentials and thread. Today it can do neither:

- **Tools** have no channel. A Slack-only tool must become a `defineDynamic` resolver that returns `null` elsewhere, taking on durable callback descriptors and closure-serialization rules just to hide a tool. To post, it loads the bot credentials again, finds the channel, thread, and team some other way (such as copying them into auth attributes), and calls `callSlackApi` by hand. #351 asks for help with exactly this.
- **Hooks** guard on `ctx.channel.kind`: `if (ctx.channel.kind !== "channel:slack") return`. The `channel:` prefix is an undocumented format, and a typo silently disables the hook.
- **Channel `events`** are documented as the place for channel-specific side effects. But on a built-in channel an authored handler replaces the default for that event, so adding a log line can drop eve's reply. The Slack channel now takes renderers (#4028), which makes a side effect there a "renderer" that must remember to call `next()`.

This plan adds one optional field, `channels`, to `defineTool` and `defineHook`. It lists the channels whose sessions receive the tool or run the hook, and gives the tool or hook that channel's handle as `ctx.channel`:

```ts title="agent/tools/post_to_slack.ts"
import { defineTool } from "eve/tools";
import { z } from "zod";
import slack from "../channels/slack";

export default defineTool({
  channels: [slack],
  description: "Post a message in this Slack thread.",
  inputSchema: z.object({ text: z.string() }),
  async execute({ text }, ctx) {
    await ctx.channel.thread.post(text);
    return { posted: true };
  },
});
```

```ts title="agent/hooks/slack-audit.ts"
import { defineHook } from "eve/hooks";
import slack from "../channels/slack";

export default defineHook({
  channels: [slack],
  events: {
    async "turn.completed"(event, ctx) {
      await recordSlackTurn({
        channelId: ctx.channel.state.channelId,
        sessionId: ctx.session.id,
        turnId: event.turnId,
      });
    },
  },
});
```

Without `channels`, both behave as they do today.

## Authoring API

```ts
interface ToolDefinition {
  /** Channels whose sessions receive this tool. Omit for every session. */
  readonly channels?: readonly Channel[];
  // …
}

interface HookDefinition {
  /** Channels whose sessions run this hook. Omit for every session. */
  readonly channels?: readonly Channel[];
  readonly events: StreamEventHooks;
}
```

Entries are channel definitions imported from `agent/channels/`, not name strings. This is the same reference [`isChannel`](../docs/guides/instrumentation/otel.mdx) already uses:

- A typo or deleted channel fails at type-check and build, not silently at runtime.
- Renaming or moving a channel file keeps references correct.
- `ctx.channel` can be typed from the reference.
- Names still come from file paths. The compiler records each tool's and hook's channel names (`["slack"]`) in the manifest, so runtime matching needs no module identity.

### `ctx.channel`

A scoped tool or hook receives `ctx.channel`: the handle the channel's own event handlers receive, plus `kind`. For Slack that is `thread`, `slack`, and `state`, the same `thread.post`, `slack.request`, credentials, team, and API host a renderer uses. A custom channel's handle is whatever its adapter builds for its handlers. The type comes from the channel definition, through a type-only field on `Channel` like the one that already carries instrumentation metadata.

With one channel listed, `ctx.channel` is that channel's handle and is never `undefined`, since the tool or hook only runs in that channel's sessions. With several, it is their union, narrowed with `isChannel(ctx.channel, slack)`. Unscoped tools still have no `ctx.channel`, and unscoped hooks keep today's `{ kind, continuationToken }`.

The handle is for acting on the conversation, not for keeping state. Renderers remain the only place authors write channel state:

- `state` is read-only (`Readonly<…>` in the type, and a copy at runtime).
- There is no `continuation.alias`.
- eve's own writes through the handle are still saved when the tool or hook returns. For example, a first `thread.post` in a session that has no thread yet makes that post the thread root, and eve records it.

`slack.request` reaches any Slack Web API method the bot token allows. A tool that passes model input into its operation or target channel lets the model post anywhere the bot can. Prefer `thread.post`, which is limited to the session's thread, and check `state.audience` before posting anything meant only for private conversations.

## Semantics

A session belongs to the channel that created it: the one `ctx.channel.kind` reports. That channel doesn't change for the life of the session; a cross-channel hand-off (`ctx.to(slack, target).send(...)`) starts a new session owned by the destination. So a session's tools are fixed from its first step, and prompt caching is unaffected.

| Session                                                                 | Matches `channels: [slack]`?            |
| ----------------------------------------------------------------------- | --------------------------------------- |
| Started or continued by `agent/channels/slack.ts`                       | Yes                                     |
| Started by another channel's `ctx.to(slack, target).send(...)`          | Yes, the new session is a Slack session |
| Started by a schedule's `to(slack, target).send(...)`                   | Yes                                     |
| A schedule's own run, without `to(...)`                                 | No                                      |
| A delegated subagent session, including one called from a Slack session | No                                      |

**Tools.** A scoped tool is left out of the model's tools in any other session, and a call to it there fails like a call to any tool the session doesn't have. The check joins `availableInSubagents` in the harness's one availability filter (`shouldHideTool`), which already applies to both the tools eve advertises and the tools it executes. Other paths that call tools, such as the `workflow` tool's generated programs, must use the same filter. An ordinary tool runs inside the session's turn step, where the channel adapter and its state are already in context, so building `ctx.channel` needs no new data flow.

**Hooks.** A scoped hook runs only for events recorded on a matching session's stream. An event a child session relays to its parent, such as a nested question, is recorded on the parent's stream and counts as the parent's. The child's own events belong to the child's session, which never matches. `ctx.cancel()` and failure isolation are unchanged.

**Delegated sessions never match.** A subagent session's channel is its parent's call, not an authored channel, and it has no Slack thread or GitHub pull request to act on. A scoped tool is therefore never available in subagents, whatever `availableInSubagents` says, and eve never has to carry a channel handle into a child.

## Validation

The build fails, naming the tool or hook file, when:

- an entry is not a channel definition from this agent's `agent/channels/`, including a value left `undefined` by an import cycle;
- `channels` is empty, since a tool or hook that never applies should be deleted;
- a local subagent's own tool or hook sets `channels`. Local subagents don't declare channels, and their sessions are always delegated, so the field could never match.

## Scope

- **`defineTool` and `defineHook` only.** A `defineWorkflowTool` body runs in its own workflow run with `WorkflowToolContext`, which carries the session but not the channel adapter, so it couldn't receive `ctx.channel`. Giving it `channels` for availability alone would make the field mean two different things.
- **Dynamic resolvers are unchanged.** `defineDynamic` tool resolvers already receive `ctx.channel` and can return `null`; `isChannel(ctx.channel, slack)` works there today.
- **App-authored definitions only.** Extension-contributed tools and hooks can't import an app's channels. Setting `channels` on them is a build error.
- **Connections, skills, subagents, and instructions** are out of scope. Their dynamic forms can already branch on `ctx.channel`.

## Compatibility

- Additive: every existing tool and hook omits `channels` and keeps its behavior.
- The `tool` and `hook` extension contracts move to their next epoch and retain the current one. The `channel` contract moves too if its report changes with the new type-only field on `Channel`.
- Docs:
  - [Tools](../docs/tools): a section on channel-scoped tools, with `post_to_slack` as the example and the `slack.request` caution.
  - [Hooks](../docs/guides/hooks.md): "Scope side effects to a channel" teaches `channels` instead of channel `events` or `ctx.channel.kind` guards.
  - [Slack](../docs/channels/slack.mdx): "Customize rendering" points side effects to scoped hooks, and "Slack API calls outside a handler" points tools to `ctx.channel`.

## Follow-ups

- Revisit the top-level `events` on other built-in channels (GitHub, Linear, and others). Once side effects have a scoped home, those maps are only for delivery, and Slack's renderer model may fit them too.
- Channel scope for workflow tools, if a use case needs a background task to act on the conversation.

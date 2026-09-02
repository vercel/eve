---
issue: TBD
status: proposed
last_updated: "2026-07-21"
---

# Channel tools: design options

Channels can receive messages, maintain delivery state, and react to session
events. They cannot give the model actions that are available only through the
active channel.

Slack makes the gap concrete. An agent cannot post to another Slack channel,
and it cannot stage a sandbox file for the Slack adapter to attach to its final
reply. The first draft proposed an async tool resolver on `defineChannel`.
Review raised a broader question: is that the right ownership boundary, or can
we fit this into eve's existing tool and extension model?

This document compares the main designs. It does not recommend one yet.

## What the design must support

- **Typed context.** Executors can use the channel's live client and state
  without casts.
- **Defaults and overrides.** Bundled channels can ship tools that applications
  can replace or disable.
- **Conditional tools.** Availability can depend on the current caller,
  channel state, or an async policy check.
- **Durable replay.** A resolved tool set survives workflow boundaries without
  rerunning policy checks or serializing live clients and credentials.
- **Discoverability.** Authors and `eve info` can explain where a tool came
  from and when it is available.
- **Off-channel behavior.** The design says what happens when another surface,
  such as web or a schedule, asks for the same capability.
- **A clear boundary.** Adding channel tools should not accidentally imply that
  every definition type can contribute every other definition type.
- **Safe context.** Channel-owned fields cannot collide with
  framework-owned `ToolContext` fields.

## Two kinds of capability

The motivating Slack tools have different lifetimes:

- `stage_file_upload` is tied to delivery. It writes to the active thread's
  durable state, and the Slack `message.completed` handler consumes that
  state. It has no useful meaning outside a Slack-backed session.
- `post_slack_message` belongs to a workspace. It needs Slack credentials,
  but it does not need the active thread. A web or scheduled session could use
  it just as well.

This distinction matters. Channel-only designs fit delivery tools but hide
workspace capabilities from other surfaces. Global designs make workspace
capabilities easy but do not provide the live state delivery tools need.

## Option A — inline resolver on the channel

Add an async `tools` resolver to `defineChannel`. eve runs it once per turn,
after the channel has hydrated auth and state. It returns a named overlay of
`defineTool(...)` definitions and `disableTool()` sentinels.

```ts
export default defineChannel({
  state: { workspaceId: null as string | null },

  context(state) {
    return { state, acme: createAcmeClient(credentials) };
  },

  async tools(ctx, { defineTool, disableTool }) {
    const canPost = ctx.session.auth.current?.attributes.canPost === true;

    return {
      post_acme_message: canPost
        ? defineTool({
            description: "Post a message to an Acme room.",
            inputSchema: z.object({ roomId: z.string(), text: z.string() }),
            execute: ({ roomId, text }, ctx) => ctx.channel.acme.postMessage(roomId, text),
          })
        : disableTool(),
    };
  },

  routes: [POST("/acme", handler)],
});
```

The overlay is durable for the turn and is reapplied after ordinary static and
dynamic tools. Bundled channels provide their defaults before the application
overlay, so an application can replace or disable a default by key. Executors
receive a freshly reconstructed channel context; they never capture the live
resolver context.

This is the shortest path to the original API. It handles typed context,
defaults, and set-level async policy well. The cost is that tools become the
product of another inline resolver, and channel ownership—not the nature of the
capability—determines where they are visible.

## Option B — a filesystem slot under the channel

Keep channel ownership, but make tools visible on disk:

```text
agent/
  channels/
    acme/
      channel.ts
      tools/
        post_message.ts
        stage_upload.ts
```

Each file exports one tool, or a dynamic resolver that returns several tools.
Names come from file paths. Bundled channel tools follow the extension override
model: an application file with the same path replaces the default, while
`disableTool()` removes it.

There are two plausible typing APIs:

```ts
// Instance-bound helper: best inference, but every tool imports the channel value.
import acme from "../channel";
export default acme.tool({/* ctx.channel is AcmeContext */});
```

```ts
// Generic helper: type-only coupling, but the author can name the wrong channel.
import { defineChannelTool } from "eve/channels";
import type acme from "../channel";
export default defineChannelTool<typeof acme>({/* ... */});
```

Putting each tool on disk fits eve's filesystem model and makes the set easy to
inspect. It requires new discovery rules beneath `channels/`, and a policy that
changes several tools may still be split across several files. Like Option A,
every tool in the slot is channel-scoped.

## Option C — ordinary dynamic tools with a typed channel accessor

Keep tools in `agent/tools/`. Channels expose a typed accessor that returns
their live context when the current session uses that channel.

```ts
// agent/tools/slack.ts
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) => {
      const slack = slackContext(ctx);
      if (slack === null) return null;

      return {
        post_message: defineTool({
          description: "Post a message to another Slack channel.",
          inputSchema: z.object({ channelId: z.string(), text: z.string() }),
          execute: ({ channelId, text }, ctx) =>
            slackContext(ctx)!.slack.request("chat.postMessage", {
              channel: channelId,
              text,
            }),
        }),
      };
    },
  },
});
```

The accessor can also be used by static tools and hooks. It avoids merging
channel fields into `ToolContext`, and the existing dynamic-tool lifecycle
already provides conditional resolution and replay.

The missing piece is bundled defaults. A channel package cannot place files in
an application's `agent/tools/`. Defaults would need a hidden channel
registry, which brings back Option A internally, or a companion extension as
in Option E.

## Option D — tools declare a channel requirement

Keep tools in their existing slot and let each tool declare the channel context
it requires:

```ts
// agent/tools/post_acme_message.ts
import acme from "../channels/acme";

export default defineTool({
  channel: acme,
  description: "Post a message to an Acme room.",
  inputSchema: z.object({ roomId: z.string(), text: z.string() }),
  execute: ({ roomId, text }, ctx) => ctx.channel.acme.postMessage(roomId, text),
});
```

The declaration controls advertisement and gives the executor a non-nullable,
inferred `ctx.channel`. Caller-specific availability can remain a dynamic tool
concern, or the API can add a per-tool `enabled(ctx)` predicate.

This is explicit and easy to search. It also allows visibility to be chosen per
tool, which fits the delivery/workspace split. Set-level policy is less
convenient: one async decision that controls five tools becomes five predicates
unless those tools come from one dynamic resolver.

Bundled defaults would merge with authored tools by name, like framework tools
today. That needs a way for a channel package to register those default
definitions without creating a second public authoring surface.

## Option E — workspace capabilities as an extension

Put workspace-wide actions in an extension rather than the channel:

```ts
// agent/extensions/slack.ts
import { slackExtension } from "eve/extensions/slack";

export default slackExtension({
  botToken: process.env.SLACK_BOT_TOKEN,
});
```

The extension can contribute namespaced tools such as
`slack__post_message` and `slack__find_user` to every session. Existing
extension discovery, overrides, `disableTool()`, compatibility metadata, and
`eve info` support all apply.

This gives workspace capabilities the cleanest off-channel behavior. It does
not solve delivery-bound tools: `stage_file_upload` needs the active channel's
state and `message.completed` handler. Option E therefore pairs with a small
channel-scoped mechanism rather than replacing one.

The channel and extension also need one credential story. Requiring authors to
configure the same Slack credentials twice would be a poor result.

## Option F — a general contributions API

Generalize the idea beyond tools:

```ts
export default defineChannel({
  contributes: {
    tools: async (ctx) => ({
      post_acme_message: defineTool({/* ... */}),
    }),
    skills: () => ({
      acme_formatting: defineSkill({/* ... */}),
    }),
    instructions: () => ["Prefer the caller's locale."],
  },
});
```

The same shape could eventually apply to extensions and other owners. The
runtime already has related lifecycle machinery for tools, skills, and
instructions.

This gives the framework one general rule instead of making channels special.
It is also much larger than the problem at hand. The first version would need
precedence and lifecycle rules across every contribution kind, while retaining
the discoverability and channel-scope drawbacks of Option A.

## Decisions shared by several options

### Context shape

Options A, B, D, and F still need to decide how channel context reaches an
executor:

1. **Flat:** `ctx.slack` or `ctx.acme`. Concise, but every future
   `ToolContext` field can collide with a channel field.
2. **Namespaced:** `ctx.channel.slack` or `ctx.channel.acme`. One reserved
   key, at the cost of one extra property access.
3. **Accessor:** `slackContext(ctx)`. No merge and explicit narrowing, but the
   result is nullable outside the matching channel.

The namespaced form is the conservative default if the chosen design merges
context. The accessor remains useful even if it is not the primary authoring
API.

### Visibility

Channel-associated tools can be:

1. available only to root sessions on the owning channel;
2. advertised more broadly and resolved or rejected at execution;
3. global when credentials do not depend on the active channel; or
4. configured per tool.

The delivery/workspace split points toward per-tool visibility. Delivery-bound
tools should be channel-only. Workspace capabilities should be global when
their credentials can be resolved independently of the active channel.

## Comparison

| Option                   | Typed context  | Defaults | Async set policy | Replay | Discoverable | Off-channel | Narrow boundary |
| ------------------------ | -------------- | -------- | ---------------- | ------ | ------------ | ----------- | --------------- |
| A — inline resolver      | Strong         | Strong   | Strong           | Strong | Weak         | Weak        | Weak            |
| B — filesystem slot      | Strong¹        | Strong   | Mixed            | Strong | Strong       | Weak        | Mixed           |
| C — accessor             | Nullable       | Missing  | Strong           | Strong | Strong       | Mixed       | Strong          |
| D — declared requirement | Strong         | Strong²  | Mixed            | Strong | Strong       | Mixed       | Strong          |
| E — extension            | Not applicable | Strong   | Mixed            | Strong | Strong       | Strong      | Strong          |
| F — contributions        | Strong         | Strong   | Strong           | Strong | Weak         | Weak        | Strong          |

¹ Depends on the instance-bound or generic helper.

² Requires an internal default-tool registration path for bundled channels.

Options can be combined. In particular:

- **C + E** keeps channel context behind an accessor and puts workspace tools in
  an extension. It still cannot bundle delivery-bound defaults without another
  registration mechanism.
- **D + E** uses declared channel requirements for delivery tools and an
  extension for workspace tools.

## How the Slack examples map to each option

| Option | `post_slack_message`                                                                     | `stage_file_upload`                                |
| ------ | ---------------------------------------------------------------------------------------- | -------------------------------------------------- |
| A      | Bundled resolver tool, available only on Slack sessions.                                 | Bundled resolver tool writing channel state.       |
| B      | File in the Slack channel's tool slot.                                                   | File in the same slot, writing channel state.      |
| C      | Ordinary dynamic tool gated by `slackContext(ctx)`; not bundleable by the channel alone. | Same, but the channel cannot ship it as a default. |
| D      | Ordinary tool with a Slack requirement, or a global extension tool.                      | Hard-scoped tool with a Slack requirement.         |
| E      | Global, namespaced extension tool.                                                       | Not supported without a channel-scoped companion.  |
| F      | Slack-owned tool contribution.                                                           | Slack-owned contribution writing channel state.    |

The upload mechanics do not depend on the authoring shape: store a
JSON-serializable queue keyed by turn and tool call, keep bytes in the sandbox,
drain the queue on the final `message.completed`, and clean up terminal turns.

## Next step

Use review feedback to narrow the list and settle context shape and visibility.
Then replace this comparison with a decision-complete specification of the
winning API. The Slack implementation should follow that API rather than add a
private registry or execution path.

---
title: "Fork Conversations into a New Thread"
description: "Copy a conversation into a new thread from a tool, so each conversation continues on its own."
---

Forking copies a conversation into a new session in a new thread, such as a side thread in the same
channel or a thread in someone's direct messages. The new session starts with the conversation so
far. After the fork, each conversation continues on its own: a later message in one never reaches
the other.

A fork needs a target that always starts a new session. A Slack target with only a `channelId`
starts a new thread in any channel the app is in, or in a DM. Many other built-in channels reuse one
session per chat, so sending the transcript there adds it to the person's existing conversation
instead of forking.

## How it works

Build the fork as a [tool](../tools) so the model decides when to call it. The tool does
three things:

1. **Identify the destination.** Start a new thread in the current channel, read from
   `ctx.session.auth.current`, open a new direct conversation with the caller, or send a new
   message elsewhere.
2. **Decide what context to seed the new session with.** Turn `ctx.messages`, the conversation the
   model saw, into the text messages the new session should have access to.
3. **Start the forked session.** Call `ctx.to(channel, target).send(...)` with a first message and
   the selected messages as `history`, the same call a route makes for a
   [cross-channel hand-off](../channels/custom#cross-channel-hand-off). The channel's `receive` hook
   maps the target to a new thread and session, and the message runs the fork's first turn.

## Fork into a new Slack thread

This tool lets someone in a Slack thread say "split this off into its own thread":

```ts title="agent/tools/fork_thread.ts"
import { defineTool, type ToolContext } from "eve/tools";
import { z } from "zod";
import slack from "../channels/slack";

export default defineTool({
  description: "Continue this conversation in a new thread in the current Slack channel.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const auth = ctx.session.auth.current;
    const channelId = auth?.attributes.channel_id;
    if (auth?.authenticator !== "slack-webhook" || typeof channelId !== "string")
      return { forked: false, reason: "This conversation is not in Slack." };

    const history = toHistory(ctx.messages);
    const delivery = await ctx
      .to(slack, { channelId })
      .send("Continue this conversation here.", { auth, history, idempotencyKey: ctx.callId });
    return { forked: true, sessionId: delivery.sessionId };
  },
});

function toHistory(messages: ToolContext["messages"]) {
  return messages.flatMap((message) => {
    if (message.role !== "user" && message.role !== "assistant") return [];
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
    return text === "" ? [] : [{ role: message.role, text }];
  });
}
```

The Slack channel's default auth sets `channel_id` and `user_id` from the message. A call from
anywhere else, such as a schedule or another channel, gets `forked: false`.

A Slack target with only a `channelId` posts the agent's first reply as a new top-level message,
which becomes the fork's thread. Every call starts a new thread and session. To fork into a
different channel, pass that channel's id instead; the app must be a member of it.

People continue the fork under the channel's usual rules. By default, a reply in a channel thread
reaches the agent only when it mentions the app. See
[Continue conversations without repeated mentions](../channels/slack#continue-conversations-without-repeated-mentions)
to answer every reply in an active thread.

### Fork into direct messages

To move the conversation into the caller's DMs instead, open a direct conversation with their
Slack user id and use its channel id as the target:

```ts title="agent/tools/fork_to_dm.ts"
import { callSlackApi } from "eve/channels/slack";

// In execute(), replace the channelId lookup:
const userId = auth?.attributes.user_id;
if (auth?.authenticator !== "slack-webhook" || typeof userId !== "string")
  return { forked: false, reason: "No Slack user to message." };
const channelId = await openDirectMessage(userId);

async function openDirectMessage(userId: string) {
  const response = await callSlackApi({
    botToken: process.env.SLACK_BOT_TOKEN,
    operation: "conversations.open",
    body: { users: userId },
  });
  if (!response.ok) throw new Error(`conversations.open failed: ${String(response.error)}`);
  return (response.channel as { id: string }).id;
}
```

`conversations.open` needs the `im:write` scope. The example reads `SLACK_BOT_TOKEN`. If your
channel uses Vercel Connect, pass the connector's `botToken` resolver to `callSlackApi` instead.

In the DM, the agent's first reply becomes a thread root, and replies in that thread continue the
fork. A new top-level DM starts a separate session. The built-in Slack DM handler answers without
a mention, and needs the `message.im` event and the `im:history` scope; see
[Message hooks](../channels/slack#message-hooks).

## What the new session sees

The fork's first model call sees the copied messages as earlier user and assistant turns, followed
by the message. `toHistory` keeps the text of user messages and assistant replies, including the
message that asked for the fork. It leaves out tool calls, files, and reasoning. `ctx.messages`
also carries eve's context messages, such as request context and recalled memory; filter them out
if the fork shouldn't see them. See [Start from prior history](../channels/eve#start-from-prior-history) for how history
joins a session.

After the fork, the original conversation and the fork are separate sessions:

- A message in the original thread reaches only its session.
- A message in the fork's thread reaches only the fork's session.
- Both keep the conversation from before the fork.

The fork runs the root agent with the auth you pass, here the caller's. Only a tool on the root
agent can fork: `ctx.to()` throws in a subagent, a root copy, or a remote agent call, since the
fork would outlive the delegation and act for the caller.

## Retries and repeated forks

Each call starts a new thread. A tool call that retries runs the tool again with the same
`ctx.callId`, so Slack maps the retry to the same thread and session, which gets the message once.
To stop the model from forking the same conversation twice, say so in the tool's
`description`, or record each fork in your app and check for one before sending.

In a [workflow tool](../tools/workflows), call `ctx.to()` in a `"use step"` helper that receives
`ctx`, as you would `ctx.getSandbox()`.

## Fork from an earlier point

To leave out the latest turns, slice `ctx.messages` before converting it. `ctx.messages` reflects
history projection and compaction, so a long conversation arrives as the model last saw it.

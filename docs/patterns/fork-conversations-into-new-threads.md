---
title: "Fork Conversations into a New Thread"
description: "Copy a conversation into a new thread from a workflow tool, so each conversation continues on its own."
---

Forking copies a conversation into a new session in a new thread, such as a side thread in the same
channel or a thread in someone's direct messages. The new session starts with the conversation so
far. After the fork, each conversation continues on its own: a later message in one never reaches
the other.

A fork needs a target that always starts a new session. Slack and Teams channels support this:

| Channel | Fork into                                                    |
| ------- | ------------------------------------------------------------ |
| Slack   | A new thread in any channel the app is in, or in a DM        |
| Teams   | A new thread in a team channel, not a personal or group chat |

Other built-in channels reuse one session per chat, so sending the transcript there adds it to the
person's existing conversation instead of forking.

## How it works

Build the fork as a [workflow tool](../tools/workflows) so the model decides when to call it. The
tool runs three steps:

1. **Identify the destination.** Start a new thread in the current channel, read from
   `ctx.session.auth.current`, open a new direct conversation with the caller, or send a new
   message elsewhere.
2. **Decide what context to seed the new session with.** Fold the session's stream with
   `transcriptReducer()` and select the messages the new session should have access to.
3. **Start the forked session.** Call
   [`ctx.sendToChannel(...)`](../tools/workflows#start-channel-sessions-ctxsendtochannel) with a
   target, a first message, and the selected messages as `history`. The channel's `receive` hook
   maps the target to a new thread and session, and the message runs the fork's first turn.

## Fork into a new Slack thread

This tool lets someone in a Slack thread say "split this off into its own thread":

```ts title="agent/tools/fork_thread.ts"
import { transcriptReducer } from "eve/client";
import { sessions } from "eve/server";
import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";
import type slack from "../channels/slack";

export default defineWorkflowTool({
  description: "Continue this conversation in a new thread in the current Slack channel.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    "use workflow";
    const auth = ctx.session.auth.current;
    const channelId = auth?.attributes.channel_id;
    if (auth?.authenticator !== "slack-webhook" || typeof channelId !== "string")
      return { forked: false, reason: "This conversation is not in Slack." };

    const history = await readTranscript(ctx.session.id);
    const { sessionId } = await ctx.sendToChannel<typeof slack>(
      "slack",
      "Continue this conversation here.",
      { target: { channelId }, auth, history },
    );
    return { forked: true, sessionId };
  },
});

async function readTranscript(sessionId: string) {
  "use step";
  const reducer = transcriptReducer();
  let transcript = reducer.initial();
  for await (const event of sessions.attach(sessionId).stream({ follow: false })) {
    transcript = reducer.reduce(transcript, event);
  }
  return transcript.messages;
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
  "use step";
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

## Fork into a new Teams thread

On Teams, the tool posts a new root message in the team channel and starts the fork under it:

```ts title="agent/tools/fork_thread.ts"
import { transcriptReducer } from "eve/client";
import { sessions } from "eve/server";
import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";
import type teams from "../channels/teams";

export default defineWorkflowTool({
  description: "Continue this conversation in a new thread in the current Teams channel.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    "use workflow";
    const auth = ctx.session.auth.current;
    const { conversation_id, scope, service_url, tenant_id } = auth?.attributes ?? {};
    if (
      auth?.authenticator !== "teams-activity" ||
      scope !== "channel" ||
      typeof conversation_id !== "string" ||
      typeof service_url !== "string"
    )
      return { forked: false, reason: "This conversation is not in a Teams channel." };

    const history = await readTranscript(ctx.session.id);
    const { sessionId } = await ctx.sendToChannel<typeof teams>(
      "teams",
      "Continue this conversation here.",
      {
        target: {
          // Drop the current thread so the fork gets its own.
          conversationId: conversation_id.split(";messageid=")[0],
          conversationType: "channel",
          initialMessage: "Continuing this conversation in a new thread.",
          serviceUrl: service_url,
          tenantId: typeof tenant_id === "string" ? tenant_id : undefined,
        },
        auth,
        history,
      },
    );
    return { forked: true, sessionId };
  },
});

// readTranscript is the same as in the Slack tool.
```

The Teams channel's default auth sets `conversation_id`, `scope`, `service_url`, and `tenant_id`
from the message. Both parts of the target matter:

- A channel message's conversation id ends in `;messageid=<thread root>`. Left in place, it names
  the current thread, and `send` joins that thread's session instead of forking.
- `initialMessage` posts the root of the new thread. Without it, the target names no thread and
  every call reaches the same session.

People reply in the new thread to continue the fork. By default, a channel message reaches the
agent only when it mentions the bot.

## What the new session sees

The fork's first model call sees the transcript as earlier user and assistant turns, followed by
the message. The transcript keeps user messages and finished assistant replies, including the message
that asked for the fork. It leaves out tool calls, files, reasoning, and replies the agent hasn't
finished. See [Start from prior history](../channels/eve#start-from-prior-history) for how history
joins a session.

After the fork, the original conversation and the fork are separate sessions:

- A message in the original thread reaches only its session.
- A message in the fork's thread reaches only the fork's session.
- Both keep the conversation from before the fork.

The fork runs the root agent with the auth you pass, here the caller's.

## Retries and repeated forks

Each call starts a new thread. A step that fails after delivering retries the delivery. eve
deduplicates a retry that reaches the same session, but a fork target gets a new thread each
time, so the retry starts a second thread. To stop the model from forking the same conversation twice, say so in the
tool's `description`, or record each fork in your app and check for one before sending.

Each platform call and the transcript read run in a `"use step"` helper, so a replayed workflow
reuses their results instead of calling the platform again.

## Fork from an earlier point

To leave out the latest turns, stop reading the stream at the `turn.started` event of the first
turn to leave out.

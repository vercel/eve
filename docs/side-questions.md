---
title: "Side Questions"
description: "Ask a quick question about a running task without steering, interrupting, or adding to its conversation."
---

A message sent while a turn is running [steers that turn](./concepts/sessions-runs-and-streaming#send-a-follow-up-message): it interrupts the model before its next output and becomes part of the conversation. Sometimes you only want to know something, such as which file the agent is editing or what the last test run said, while it keeps working. `eve/extensions/btw` answers those side questions on the side, like `/btw` in coding harnesses.

The answer comes from the session as it stands, including the turn still running. Nothing is delivered to the session, so the running turn never sees the question, and neither the question nor the answer joins its history.

## Offer the command

`btwCommand()` returns a [command](./channels/eve#slash-commands). Add it to the eve channel under the name you want:

```ts title="agent/channels/eve.ts"
import { eveChannel } from "eve/channels/eve";
import { localDev, vercelOidc } from "eve/channels/auth";
import { btwCommand } from "eve/extensions/btw";

export default eveChannel({
  auth: [vercelOidc(), localDev()],
  commands: { btw: btwCommand() },
});
```

In the terminal UI or Web Chat, type `/btw which branch are you on?`. The answer is shown only to you, and the turn carries on. The command needs a session, so it runs once the conversation has started.

The same command runs in Slack threads through `findCommand` and `runCommand`; see [Slack commands](./channels/slack#add-commands). The answer posts in the thread, and the message never reaches the model.

## Configure the answer

Every option is optional:

```ts
btwCommand({
  // The model that answers: an AI Gateway model ID or an AI SDK model instance.
  // Default: the model the session's latest turn ran on, through AI Gateway, or
  // "openai/gpt-6-luna-fast" when there is none or that call fails. Ignored when `answer` is set.
  model: "openai/gpt-6-luna-fast",
  // Characters of the session the answer reads, newest first. Default 24,000.
  maxContextChars: 24_000,
  // Replaces the default answer.
  // Receives { question, transcript, view, sessionId, sessionModelId, abortSignal }.
  answer: async ({ question, transcript }) => myAnswer(question, transcript),
});
```

The default answer is one model call with no tools. It reads a transcript of the session: each turn's messages, the agent's text, and its tool calls with their inputs, outputs, and state. The running turn is marked as running and includes the text it is still streaming. When the transcript is too long, the oldest lines are dropped. Every value is JSON-encoded so text from the session can't pass as instructions. The answer says so when a question asks the agent to do something, since nothing reaches the agent.

`answer` replaces that call. `view` is the session's [snapshot](./concepts/sessions-runs-and-streaming#query-session-state) when the question was asked, for answers that query it with `eve/events`.

## Ask from your own code

`askAside(sessionId, question, options?, abortSignal?)` returns the answer as a string. It takes the same options as `btwCommand`. Use it from code running inside the eve server, such as a channel route. It reads the session with [`sessions` from `eve/server`](./concepts/sessions-runs-and-streaming#read-a-session-in-process), which reads any session ID without auth, so check that the caller may read the session first.

## Limits

- The answer knows only what the session has recorded. Recent work can take a moment to reach it, and it can't see files or run tools.
- The answer runs on the session's model by default, but it isn't the agent: it gets the transcript, not the agent's instructions, skills, or tools.

---
title: "Private Context Extension"
description: "Record whose private data a session read, ask that person before writes, and deny personal reads in public conversations."
---

`eve/extensions/private-context` records whose private data a session's model has read, such as someone's private Notion pages or Slack DM history. Two agent-wide [approval policies](./human-in-the-loop#gate-every-call-from-one-policy) act on it:

- **Private context.** Once the session holds someone's personal data, a call that writes outside the session asks a person first.
- **Audience.** In a conversation visible outside its participants, such as a public Slack channel, a call that reads personal data is denied, because the reply itself could leak what it returns.

The extension is a proof of concept. It ships inside the `eve` package and uses only [tags](./human-in-the-loop#tag-entries-for-policies), [hooks](./guides/hooks), [state](./concepts/state), [`ctx.session.audience`](./guides/session-context#ctxsession), and the agent-wide `approval` policy. Read [Limits](#limits) before you rely on it.

[`eve/extensions/taint`](./taint-extension) answers a different question: who could have written what the model read. Mount either one, or both.

## Mount the extension

```ts title="agent/extensions/private-context.ts"
export { default } from "eve/extensions/private-context";
```

```ts title="agent/agent.ts"
import { defineAgent } from "eve";
import { privateContext } from "eve/extensions/private-context";

export default defineAgent({
  model: "anthropic/claude-sonnet-4.6",
  approval: privateContext(),
});
```

Mount it once. The policy reads the mount's state, and with two mounts the build can't tell which one `agent.ts` means.

`strictest()` combines policies and keeps the strictest answer: denied, then user approval, then approved, then `undefined`. Among equals the first wins, so its reason is kept. Use it to run both extensions:

```ts title="agent/agent.ts"
import { defineAgent } from "eve";
import { privateContext, strictest } from "eve/extensions/private-context";
import { taintPolicy } from "eve/extensions/taint";

export default defineAgent({
  model: "anthropic/claude-sonnet-4.6",
  approval: strictest(taintPolicy(), privateContext()),
});
```

## Tag your entries

eve doesn't interpret tags. The extension reads three of them:

| Tag               | Meaning                                                                            |
| ----------------- | ---------------------------------------------------------------------------------- |
| `reads:personal`  | The result can contain the caller's private data, read with their own credentials. |
| `effect:external` | The call changes state or sends data outside the session.                          |
| `effect:export`   | The call moves data somewhere bulk or persistent: an export, upload, or share.     |

`effect:external` and `effect:export` mean the same thing to the taint extension.

```ts title="agent/connections/notes.ts"
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://notes.example.com/mcp",
  description: "The signed-in user's private notes.",
  tags: {
    default: ["reads:personal"],
    tools: { share_page: ["effect:external"] },
  },
});
```

Built-in tools have no tags. The built-in `agent` tool counts as `reads:personal`, because its copy of the agent has the same tools.

## Whose data a session holds

The extension's hook keeps, for each session:

- `caller`: the principal id of the latest message's sender. A turn's calls run with that person's credentials.
- `owners`: the principal ids whose data the session read. A completed `reads:personal` call adds the `caller`, or `"unknown"` when the message had no principal.
- `sources`: the names of the tools that read it, up to 20, newest last.

Only a completed call counts. A failed call records nothing, because the service may have refused it.

## What the policies decide

`privateContextPolicy()`:

| Session                | Call                                                   | Decision          |
| ---------------------- | ------------------------------------------------------ | ----------------- |
| Holds no personal data | anything                                               | `undefined`       |
| Holds someone's data   | tagged `effect:external` or `effect:export`            | `"user-approval"` |
| Holds someone's data   | connection tool with no tags, not `readOnlyHint: true` | `"user-approval"` |

Set `untaggedConnections: "ignore"` to leave untagged connection tools alone. A tool counts as a connection tool when its server sent annotations or its name has the `<connection>__<tool>` shape. Mounted extension tools have that shape too, so they're also asked about.

`audiencePolicy()` denies a call tagged `reads:personal` unless `ctx.session.audience` is `"private"`. The reason the model gets is: "This conversation is visible outside its participants, so personal data can't be read here." `"unknown"` counts as public. Set `treatUnknownAs: "private"` to allow those sessions, for example for an agent only reachable over an authenticated API.

`privateContext()` takes both policies' options and combines them with `strictest()`.

## Audience by channel

eve classifies the audience when a session starts:

| Channel                         | `private`                        | `public`        | `unknown`                      |
| ------------------------------- | -------------------------------- | --------------- | ------------------------------ |
| Slack                           | DMs, group DMs, private channels | public channels |                                |
| Discord                         | DMs, group DMs, private threads  |                 | guild channels, public threads |
| Teams                           | personal and group chats         |                 | channels                       |
| GitHub, Linear, MCP, plain HTTP |                                  |                 | everything                     |

A Slack thread has its channel's audience. A local subagent has its parent's. The audience doesn't change for later messages in the same session.

## Subagents

Each session has its own state. A subagent starts with none, and its own calls run under the root agent's policy against the subagent's state.

- **Child to parent.** Tag a subagent or remote agent that can read personal data with `reads:personal`, so calling it marks the parent as holding the caller's data.
- **Parent to child.** Nothing passes the parent's state into a child. A child inherits the parent's audience, so the audience policy applies there too.

## Limits

- **Approvers.** An agent-wide `"user-approval"` can't carry a reason, so the approver sees the tool's own prompt. It also can't choose who may answer. By default only the person whose turn made the call can, so after Bob's message, Bob approves a post built from Alice's notes. A tool's own `approval.response` policy can restrict responders.
- **Shared credentials.** Owners assume per-user credentials. A tool that reads through a shared account needs its own tag.
- **Memory.** Memory isn't covered. A capture from a session that holds personal data, into memory others can recall, leaks that data without a call to gate.
- A hook's write can be lost if a step is interrupted after the event is recorded and before the step's state is saved.
- Sessions that started before you mounted the extension aren't tracked.
- The policies don't gate provider-executed tools, `ctx.agent()` from workflow code, or a remote agent's own calls.

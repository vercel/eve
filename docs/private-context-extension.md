---
title: "Private Context Extension"
description: "Record what confidential data a session read, ask before it leaves for somewhere its readers shouldn't see it, and deny confidential reads in conversations that are too open."
---

`eve/extensions/private-context` tracks confidentiality. It records how confidential the data a session's model has read is, and whose personal data it holds. Two agent-wide [approval policies](./human-in-the-loop#gate-every-call-from-one-policy) act on it:

- **Sink caps.** A call that would send data somewhere its readers shouldn't see it asks a person first. Sending Alice's notes back to Alice doesn't.
- **Audience.** A call that reads data the conversation's readers shouldn't see is denied, because the reply itself could leak it. Personal data is read only in private conversations, and sensitive company data only inside the workspace.

The extension is a proof of concept. It ships inside the `eve` package and uses only [tags](./human-in-the-loop#tag-entries-for-policies), [hooks](./guides/hooks), [state](./concepts/state), [`ctx.session.audience`](./guides/session-context#ctxsession), and the agent-wide `approval` policy. Read [Limits](#limits) before you rely on it.

[`eve/extensions/untrusted-content`](./untrusted-content-extension) tracks integrity instead: who could have written what the model read. Mount either one, or [both](#use-it-with-untrusted-content).

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

## Tag your entries

eve doesn't interpret tags. The extension reads these, named to line up with MCP's draft annotations, SEP-2061, and FIDES labels:

| Tag                   | Meaning                                                                            | MCP counterpart                                                                                          |
| --------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `reads:sensitive`     | The result can contain sensitive company data.                                     | Trust annotations `sensitive: true`; data class `confidential` or `highly_confidential`; FIDES `private` |
| `reads:personal`      | The result can contain the caller's private data, read with their own credentials. | Data class `personal`; SEP-2061 sensitivity `PII` or `User`; FIDES `user_identity`                       |
| `sink:public`         | The call can put data somewhere publicly accessible.                               | SEP-2061 destination `Public`                                                                            |
| `sink:internal`       | The call puts data where a restricted internal audience sees it.                   | SEP-2061 destination `Internal`                                                                          |
| `sink:user`           | The call puts data where only the user it's helping sees it.                       | SEP-2061 destination `User`                                                                              |
| `effect:external`     | The call changes state or sends data outside the session.                          | `readOnlyHint: false`                                                                                    |
| `effect:irreversible` | The call can't be undone. It counts as external too.                               | `destructiveHint: true`                                                                                  |

`reads:personal` is above `reads:sensitive`. A call that stores data where nobody else reads it, SEP-2061's `Ephemeral` or `System`, isn't an exit point and needs no `sink:*` tag.

```ts title="agent/connections/notes.ts"
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://notes.example.com/mcp",
  description: "The signed-in user's private notes.",
  tags: {
    default: ["reads:personal"],
    tools: { share_page: ["effect:external", "sink:internal"] },
  },
});
```

Built-in tools have no tags. The built-in `agent` tool counts as `reads:personal`, because its copy of the agent has the same tools.

## What the session records

- `caller`: the principal id of the latest message's sender. A turn's calls run with that person's credentials.
- `owners` and `sources`: whose personal data the session read, and which tools read it. A completed `reads:personal` call adds the `caller`, or `"unknown"` when the message had no principal.
- `sensitive` and `sensitiveSources`: whether the session read sensitive company data, and which tools read it.

Only a completed call counts. A failed call records nothing, because the service may have refused it. Each source list keeps up to 20 tool names, newest last.

## Sink caps

A call is a sink when it has a `sink:*` tag or an `effect:*` tag. Its `sink:*` tag sets its cap. A sink with no `sink:*` tag is capped at public, as is a connection tool with no tags that its server doesn't mark `readOnlyHint: true`.

| Data the session holds | `sink:public` | `sink:internal` | `sink:user`                       |
| ---------------------- | ------------- | --------------- | --------------------------------- |
| Nothing confidential   | runs          | runs            | runs                              |
| Sensitive              | exceeds       | runs            | runs                              |
| Personal               | exceeds       | exceeds         | runs when the user owns all of it |

`privateContextPolicy()` asks before a call that exceeds its cap. Options:

```ts
privateContextPolicy({
  // Leave sensitive data past a cap to other policies. Personal data still asks. Default "ask".
  sensitiveFlows: "allow",
  // Leave connection tools with no tags alone. Default "treat-as-write".
  untaggedConnections: "ignore",
});
```

A tool counts as a connection tool when its server sent annotations or its name has the `<connection>__<tool>` shape. Mounted extension tools have that shape too.

`exceedsCap(ctx)` returns whether a call would exceed its cap, for use in other policies.

## Audience

`audiencePolicy()` denies a read that the conversation's readers shouldn't see, from `ctx.session.audience`:

| Audience  | Who reads the conversation | `reads:sensitive` | `reads:personal` |
| --------- | -------------------------- | ----------------- | ---------------- |
| `private` | its participants           | runs              | runs             |
| `public`  | the workspace              | runs              | denied           |
| `unknown` | anyone, by default         | denied            | denied           |

Set `treatUnknownAs: "internal"` or `"private"` for an agent only reachable from inside the company. The denied call returns a reason to the model, such as "This conversation is visible outside its participants, so personal data can't be read here."

eve classifies the audience when a session starts. Slack DMs, group DMs, and private channels are `private`, and public channels are `public`. Discord guild channels, Teams channels, GitHub, Linear, MCP, and plain HTTP sessions are `unknown`. A local subagent has its parent's audience.

`privateContext()` takes both policies' options and combines them with `strictest()`.

## Use it with untrusted content

[`eve/extensions/untrusted-content`](./untrusted-content-extension) takes a `when` check. Pass `exceedsCap` to it, and allow sensitive flows here, to get Meta's Rule of Two: sensitive data past a cap asks only when the session also read untrusted content, while personal data past a cap always asks.

```ts title="agent/agent.ts"
import { defineAgent } from "eve";
import { exceedsCap, privateContext, strictest } from "eve/extensions/private-context";
import { untrustedContentPolicy } from "eve/extensions/untrusted-content";

export default defineAgent({
  model: "anthropic/claude-sonnet-4.6",
  approval: strictest(
    untrustedContentPolicy({ when: exceedsCap }),
    privateContext({ sensitiveFlows: "allow" }),
  ),
});
```

`strictest()` keeps the strictest answer: denied, then user approval, then approved, then `undefined`. Among equals the first wins, so its reason is kept.

## Subagents

Each session has its own state. A subagent starts with none, and its own calls run under the root agent's policy against the subagent's state.

- **Child to parent.** Tag a subagent or remote agent with the level of data it can read, so calling it records that level in the parent.
- **Parent to child.** Nothing passes the parent's state into a child. A child inherits the parent's audience, so the audience policy applies there too.

## Limits

- **Tags describe a tool, not one result.** A tool tagged `reads:personal` counts on every call, even when a result holds nothing personal. MCP's draft annotations label each result; eve doesn't read them yet.
- **`sink:user` assumes the destination is the caller.** The policy can't see who a tool sends to, so a `sink:user` tool must only reach the user it's helping.
- **`public` means the workspace.** eve doesn't tell a Slack channel shared with another company from an ordinary public channel, so sensitive data can be read in both.
- **Approvers.** An agent-wide `"user-approval"` can't carry a reason, so the approver sees the tool's own prompt. It also can't choose who may answer. By default only the person whose turn made the call can, so after Bob's message, Bob approves a post built from Alice's notes.
- **Shared credentials.** Owners assume per-user credentials. A tool that reads through a shared account needs `reads:sensitive`, not `reads:personal`.
- **Memory.** A capture from a session that holds personal data, into memory others can recall, leaks it without a call to gate.
- A hook's write can be lost if a step is interrupted after the event is recorded and before the step's state is saved.
- Sessions that started before you mounted the extension aren't tracked.
- The policies don't gate provider-executed tools, `ctx.agent()` from workflow code, or a remote agent's own calls.

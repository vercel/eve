---
title: "Untrusted Content Extension"
description: "Record when a session reads untrusted content, then ask a person before external effects and deny publishing."
---

`eve/extensions/untrusted-content` tracks integrity. It records when a session's model reads content that someone outside your trust boundary could have written, such as a public issue, a web page, or a message from another user. An agent-wide [approval policy](./human-in-the-loop#gate-every-call-from-one-policy) then acts on it. Once the session is exposed, it asks a person before external and irreversible calls, and denies calls that would publish data for good. Until then, it changes nothing.

It tracks only who could have written what the model read, not how sensitive that data is. To ask only when untrusted content and sensitive data meet, Meta's [Rule of Two](https://ai.meta.com/blog/practical-ai-agent-security/), combine it with a confidentiality check through [`when`](#combine-with-a-confidentiality-check).

The extension is a proof of concept. It ships inside the `eve` package and uses only [tags](./human-in-the-loop#tag-entries-for-policies), [hooks](./guides/hooks), [state](./concepts/state), and the agent-wide `approval` policy. Read [Limits](#limits) before you rely on it.

## Mount the extension

Mount the extension, then set its policy as the agent's `approval`:

```ts title="agent/extensions/untrusted-content.ts"
import untrustedContent from "eve/extensions/untrusted-content";

export default untrustedContent({});
```

```ts title="agent/agent.ts"
import { defineAgent } from "eve";
import { untrustedContentPolicy } from "eve/extensions/untrusted-content";

export default defineAgent({
  model: "anthropic/claude-sonnet-4.6",
  approval: untrustedContentPolicy(),
});
```

Mount it once. The policy reads the mount's state, and with two mounts the build can't tell which one `agent.ts` means.

To keep a policy of your own, return the untrusted content policy's answer when it has one:

```ts title="agent/agent.ts"
import { defineAgent } from "eve";
import { untrustedContentPolicy } from "eve/extensions/untrusted-content";

const untrusted = untrustedContentPolicy();

export default defineAgent({
  model: "anthropic/claude-sonnet-4.6",
  approval: async (ctx) => (await untrusted(ctx)) ?? myPolicy(ctx),
});
```

## Tag your entries

eve doesn't interpret tags. The extension reads these, named to line up with MCP's tool hints and draft annotations:

| Tag                   | Meaning                                                               | MCP counterpart                                                                                            |
| --------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `reads:untrusted`     | The result can contain text someone outside the trust boundary wrote. | Trust annotations `untrusted: true`; action metadata source `UntrustedPublic`; FIDES integrity `untrusted` |
| `effect:external`     | The call changes state or sends data outside the session.             | `readOnlyHint: false`; action metadata outcome `consequential`                                             |
| `effect:irreversible` | The call can't be undone, such as deleting a repository.              | `destructiveHint: true`; action metadata outcome `irreversible`                                            |
| `sink:public`         | The call can put data somewhere publicly accessible.                  | SEP-2061 destination `Public`                                                                              |

An irreversible call counts as external too. Trusted sources (MCP's `TrustedPublic`, `Internal`, `User`, and `System`) need no tag.

Tag tools, connections, subagents, and remote agents:

```ts title="agent/connections/issues.ts"
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://issues.example.com/mcp",
  description: "Public issue tracker.",
  tags: {
    default: ["reads:untrusted"],
    tools: { create_comment: ["effect:external", "sink:public"] },
  },
});
```

Built-in tools have no tags, so the extension treats `web_fetch`, `web_search`, `bash`, and `agent` as `reads:untrusted` by name. A tool you author with one of those names is judged by its own tags.

## What exposes a session

- **An untrusted call.** A call tagged `reads:untrusted` exposes the session when it settles, unless it was rejected before it ran. A failed or interrupted call still exposes it, because it can return text it read.
- **A message from someone else.** A delivery whose principal isn't the session's initiator exposes the session, with source `message`. Turn this off with `untrustedContent({ untrustedMessages: false })`.

The state lists up to 20 sources, newest last: tool names and `message`.

## What the policy decides

| Session     | Call tagged                           | Decision                                                 |
| ----------- | ------------------------------------- | -------------------------------------------------------- |
| Not exposed | anything                              | `undefined`: the call's own approval decides.            |
| Exposed     | `effect:irreversible` + `sink:public` | Denied, with a reason that names the sources.            |
| Exposed     | `effect:irreversible`                 | `"user-approval"`: a person approves or denies the call. |
| Exposed     | `effect:external`                     | `"user-approval"`                                        |
| Exposed     | anything else                         | `undefined`                                              |

The agent-wide policy runs beside each entry's own `approval`, and the stricter decision wins, so it can add a gate but never remove one. A denied call returns the reason to the model.

`untrustedContentPolicy()` takes options:

```ts
untrustedContentPolicy({
  // Ask a person before publishing instead of denying it. Default "deny".
  onPublish: "user-approval",
  // Judge connection tools with no tags by their server's hints. Default "ignore".
  untaggedConnections: "treat-as-external",
  // Also mark the session exposed when an untrusted call is requested. Default false.
  markOnRequest: true,
  // Gate external calls only when this also holds. Default: every call.
  when: (ctx) => true,
});
```

`untaggedConnections: "treat-as-external"` counts a connection tool with no tags as external unless its server marks it `readOnlyHint: true`, and as irreversible when the server marks it `destructiveHint: true`. A tool counts as a connection tool when its server sent annotations or its name has the `<connection>__<tool>` shape. Mounted extension tools have that shape too, so they also count.

`markOnRequest` marks the session exposed from the policy, as soon as the untrusted call is requested. The mark lands in the same step as the request, so it doesn't depend on the hook. A call that is then denied still exposes the session.

### Combine with a confidentiality check

On its own, the policy asks before every external call in an exposed session. `when` narrows that to the calls that also matter for confidentiality, such as a call that would send sensitive data somewhere its readers shouldn't see it. That gives the Rule of Two: ask only when untrusted content, sensitive data, and an external effect meet.

```ts title="agent/agent.ts"
import { defineAgent } from "eve";
import { untrustedContentPolicy } from "eve/extensions/untrusted-content";

export default defineAgent({
  model: "anthropic/claude-sonnet-4.6",
  // `sendsSensitiveData` is your own check of what the call would send, and where.
  approval: untrustedContentPolicy({ when: (ctx) => sendsSensitiveData(ctx) }),
});
```

Irreversible calls ask in an exposed session whatever `when` returns, because an injected instruction can do damage with them without moving any data.

## Subagents

Each session has its own exposure. A subagent starts clean, and its own calls run under the root agent's policy against the subagent's exposure, not the parent's.

- **Child to parent.** Tag a subagent or remote agent that can read untrusted content with `reads:untrusted`, so calling it exposes the parent. The built-in `agent` tool counts as untrusted, because its copy has the parent's tools.
- **Parent to child.** An exposed parent asks before calling a subagent tagged `effect:external`. Nothing passes the parent's exposure into the child.

A subagent runs as a task. Its call settles, and exposes the parent, when its result is ready, so the parent's calls while it runs are decided on what the parent has read so far.

## Telemetry

`untrustedContentRuntimeContext()` returns `untrusted.exposed` and `untrusted.sources` (comma-joined, truncated to 256 characters) for [`runtimeContext`](./observability/otel#add-runtime-context):

```ts title="agent/instrumentation/traces.ts"
import { otelIntegration } from "eve/instrumentation/otel";
import { untrustedContentRuntimeContext } from "eve/extensions/untrusted-content";

export default otelIntegration({
  runtimeContext: () => untrustedContentRuntimeContext(),
});
```

The values reach only the AI SDK spans of each model attempt. Tool spans already carry the call's tags as `agent.tool.tags`.

## Timing

The extension's hook runs before eve continues past each event, so a call the model makes in a later step sees what earlier calls exposed. Calls in the same model response are approved together, so a call made alongside an untrusted read isn't gated by it. The model wrote both before it read the result.

## Limits

- Tags describe a tool, not one result. A tool tagged `reads:untrusted` exposes the session even when a given result is trusted, and an untagged tool never does. MCP's draft annotations label each result; eve doesn't read them yet.
- Unlabeled output counts as trusted. FIDES treats it as untrusted.
- A hook's write can be lost if a step is interrupted after the event is recorded and before the step's state is saved. `markOnRequest` narrows this.
- Exposure doesn't pass from a parent to its subagents. It passes from a subagent to its parent only through the subagent's tags.
- Sessions that started before you mounted the extension aren't tracked.
- There's no live view of exposure for clients and no run-level tag in Agent Runs.
- An agent-wide `"user-approval"` can't carry a reason, so the approver sees the tool's own prompt.
- The policy doesn't gate provider-executed tools, `ctx.agent()` from workflow code, a remote agent's own calls, or memory recall.

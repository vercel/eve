---
title: "Taint Extension"
description: "Ask a person before an external effect only when a session combines untrusted content and sensitive data, following the Rule of Two."
---

`eve/extensions/taint` applies Meta's [Rule of Two](https://ai.meta.com/blog/practical-ai-agent-security/) to a session. A prompt injection can only cause real harm when three things meet:

1. The model read **untrusted content**: text someone outside your trust boundary could have written, such as a public issue, a web page, or a message from another user.
2. The session has **sensitive data or systems** in reach: it read private data, or the call acts on a sensitive system.
3. The call has an **external effect**: it changes state or sends data outside the session.

The extension records the first two as the session runs. An agent-wide [approval policy](./human-in-the-loop#gate-every-call-from-one-policy) then asks a person before an external effect only when all three meet, and denies exports. Any two alone change nothing, so most sessions never see a prompt.

The extension is a proof of concept. It ships inside the `eve` package and uses only [tags](./human-in-the-loop#tag-entries-for-policies), [hooks](./guides/hooks), [state](./concepts/state), and the agent-wide `approval` policy. Read [Limits](#limits) before you rely on it.

## Mount the extension

Mount the extension, then set its policy as the agent's `approval`:

```ts title="agent/extensions/taint.ts"
import taint from "eve/extensions/taint";

export default taint({});
```

```ts title="agent/agent.ts"
import { defineAgent } from "eve";
import { taintPolicy } from "eve/extensions/taint";

export default defineAgent({
  model: "anthropic/claude-sonnet-4.6",
  approval: taintPolicy(),
});
```

Mount it once. The policy reads the mount's state, and with two mounts the build can't tell which one `agent.ts` means.

To keep a policy of your own, return the taint policy's answer when it has one:

```ts title="agent/agent.ts"
import { defineAgent } from "eve";
import { taintPolicy } from "eve/extensions/taint";

const taint = taintPolicy();

export default defineAgent({
  model: "anthropic/claude-sonnet-4.6",
  approval: async (ctx) => (await taint(ctx)) ?? myPolicy(ctx),
});
```

## Tag your entries

eve doesn't interpret tags. The extension reads these:

| Tag                | Leg       | Meaning                                                                        |
| ------------------ | --------- | ------------------------------------------------------------------------------ |
| `reads:untrusted`  | untrusted | The result can contain text someone outside the trust boundary wrote.          |
| `reads:sensitive`  | sensitive | The result can contain private or sensitive data.                              |
| `reads:personal`   | sensitive | The result can contain the caller's private data.                              |
| `effect:sensitive` | sensitive | The call acts on a sensitive system, such as production or billing.            |
| `effect:external`  | effect    | The call changes state or sends data outside the session.                      |
| `effect:export`    | effect    | The call moves data somewhere bulk or persistent: an export, upload, or share. |

`reads:personal` marks the caller's own data, such as their private notes or DMs. `effect:sensitive` covers the case where nothing sensitive was read but the call itself can do damage: after reading an injected issue, a `delete_repo` tagged `effect:external` and `effect:sensitive` asks.

Tag tools, connections, subagents, and remote agents:

```ts title="agent/connections/issues.ts"
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://issues.example.com/mcp",
  description: "Public issue tracker.",
  tags: {
    default: ["reads:untrusted"],
    tools: { create_comment: ["effect:external"] },
  },
});
```

Built-in tools have no tags, so the extension treats `web_fetch`, `web_search`, and `bash` as `reads:untrusted` by name. It treats `agent` as both `reads:untrusted` and `reads:sensitive`, because its copy has the agent's tools. A tool you author with one of those names is judged by its own tags.

## What the session records

- **Untrusted content.** A call tagged `reads:untrusted` counts when it settles, unless it was rejected before it ran. A failed or interrupted call still counts, because it can return text it read. A delivery whose principal isn't the session's initiator counts too, with source `message`. Turn that off with `taint({ untrustedMessages: false })`.
- **Sensitive data.** A call tagged `reads:sensitive` or `reads:personal` counts the same way.

Each leg lists up to 20 sources, newest last: tool names, and `message`.

## What the policy decides

| Untrusted content | Sensitive data or system | Call tagged       | Decision                                                 |
| ----------------- | ------------------------ | ----------------- | -------------------------------------------------------- |
| No                | either                   | anything          | `undefined`: the call's own approval decides.            |
| Yes               | No                       | anything          | `undefined`                                              |
| Yes               | Yes                      | `effect:export`   | Denied, with a reason that names both legs' sources.     |
| Yes               | Yes                      | `effect:external` | `"user-approval"`: a person approves or denies the call. |
| Yes               | Yes                      | anything else     | `undefined`                                              |

The agent-wide policy runs beside each entry's own `approval`, and the stricter decision wins, so it can add a gate but never remove one. A denied call returns the reason to the model.

`taintPolicy()` takes options:

```ts
taintPolicy({
  // Tags to read instead of the defaults.
  exportTag: "effect:export",
  externalTag: "effect:external",
  // Ask a person before exports instead of denying them. Default "deny".
  onExport: "user-approval",
  // Count connection tools with no tags as external, unless the server marks them read-only. Default "ignore".
  untaggedConnections: "treat-as-external",
  // Treat every session as holding sensitive data, so untrusted content alone gates effects. Default false.
  assumeSensitive: true,
  // Also record a read when it's requested. Default false.
  markOnRequest: true,
});
```

`untaggedConnections: "treat-as-external"` treats a tool as a connection tool when its server sent annotations or its name has the `<connection>__<tool>` shape. Mounted extension tools have that shape too, so they also count.

`assumeSensitive` is the stricter setup: an agent whose tools can all reach sensitive data, or whose sensitive reads you haven't tagged, gates on untrusted content alone.

`markOnRequest` records a read from the policy, as soon as it's requested. The mark lands in the same step as the request, so it doesn't depend on the hook. A call that is then denied still counts.

## Subagents

Each session has its own record. A subagent starts clean, and its own calls run under the root agent's policy against the subagent's record, not the parent's.

- **Child to parent.** Tag a subagent or remote agent with the legs it can read, so calling it records them in the parent. The built-in `agent` tool counts as both.
- **Parent to child.** Once the parent has both legs, it asks before calling a subagent tagged `effect:external`. Nothing passes the parent's record into the child.

A subagent runs as a task. Its call settles, and records its legs in the parent, when its result is ready, so the parent's calls while it runs are decided on what the parent has read so far.

## Telemetry

`taintRuntimeContext()` returns `taint.exposed`, `taint.sensitive`, and their sources as `taint.sources` and `taint.sensitive_sources` (comma-joined, truncated to 256 characters) for [`runtimeContext`](./observability/otel#add-runtime-context):

```ts title="agent/instrumentation/traces.ts"
import { otelIntegration } from "eve/instrumentation/otel";
import { taintRuntimeContext } from "eve/extensions/taint";

export default otelIntegration({
  runtimeContext: () => taintRuntimeContext(),
});
```

The values reach only the AI SDK spans of each model attempt. Tool spans already carry the call's tags as `agent.tool.tags`.

## Timing

The extension's hook runs before eve continues past each event, so a call the model makes in a later step sees what earlier calls recorded. Calls in the same model response are approved together, so a call made alongside the read that completes a leg isn't gated by it. The model wrote both before it read the result.

## Limits

- The sensitive leg covers only what's tagged. Untagged reads of private data, and untagged calls to sensitive systems, don't count. Use `assumeSensitive` when you can't tag them.
- The Rule of Two is about prompt injection. It doesn't stop the model from posting private data to the wrong audience on its own.
- A hook's write can be lost if a step is interrupted after the event is recorded and before the step's state is saved. `markOnRequest` narrows this.
- Records don't pass from a parent to its subagents. They pass from a subagent to its parent only through the subagent's tags.
- Sessions that started before you mounted the extension aren't tracked.
- There's no live view of the record for clients and no run-level tag in Agent Runs.
- An agent-wide `"user-approval"` can't carry a reason, so the approver sees the tool's own prompt.
- The policy doesn't gate provider-executed tools, `ctx.agent()` from workflow code, a remote agent's own calls, or memory recall.

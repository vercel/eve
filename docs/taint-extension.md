---
title: "Taint Extension"
description: "Record when a session reads untrusted content, then ask a person before external effects and deny exports."
---

`eve/extensions/taint` records when a session's model reads content that someone outside your trust boundary could have written, such as a public issue, a web page, or a message from another user. An agent-wide [approval policy](./human-in-the-loop#gate-every-call-from-one-policy) then acts on it. Once the session is exposed, it asks a person before external effects and denies exports. Until then, it changes nothing.

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

eve doesn't interpret tags. The extension reads three of them:

| Tag               | Meaning                                                                        |
| ----------------- | ------------------------------------------------------------------------------ |
| `reads:untrusted` | The result can contain text someone outside the trust boundary wrote.          |
| `effect:external` | The call changes state or sends data outside the session.                      |
| `effect:export`   | The call moves data somewhere bulk or persistent: an export, upload, or share. |

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

Built-in tools have no tags, so the extension treats `web_fetch`, `web_search`, `bash`, and `agent` as `reads:untrusted` by name. A tool you author with one of those names is judged by its own tags.

## What exposes a session

- **An untrusted call.** A call tagged `reads:untrusted` exposes the session when it settles, unless it was rejected before it ran. A failed or interrupted call still exposes it, because it can return text it read.
- **A message from someone else.** A delivery whose principal isn't the session's initiator exposes the session, with source `message`. Turn this off with `taint({ untrustedMessages: false })`.

The state lists up to 20 sources, newest last: tool names and `message`.

## What the policy decides

| Session     | Call tagged       | Decision                                                 |
| ----------- | ----------------- | -------------------------------------------------------- |
| Not exposed | anything          | `undefined`: the call's own approval decides.            |
| Exposed     | `effect:export`   | Denied, with a reason that names the sources.            |
| Exposed     | `effect:external` | `"user-approval"`: a person approves or denies the call. |
| Exposed     | anything else     | `undefined`                                              |

The agent-wide policy runs beside each entry's own `approval`, and the stricter decision wins, so it can add a gate but never remove one. A denied call returns the reason to the model.

`taintPolicy()` takes options:

```ts
taintPolicy({
  // Tags to read instead of the defaults.
  exportTag: "effect:export",
  externalTag: "effect:external",
  // Ask a person before exports instead of denying them. Default "deny".
  onExport: "user-approval",
  // Ask before connection tools with no tags, unless the server marks them read-only. Default "ignore".
  untaggedConnections: "treat-as-external",
  // Also mark the session exposed when an untrusted call is requested. Default false.
  markOnRequest: true,
});
```

`untaggedConnections: "treat-as-external"` treats a tool as a connection tool when its server sent annotations or its name has the `<connection>__<tool>` shape. Mounted extension tools have that shape too, so they're also asked about.

`markOnRequest` marks the session exposed from the policy, as soon as the untrusted call is requested. The mark lands in the same step as the request, so it doesn't depend on the hook. A call that is then denied still exposes the session.

## Subagents

Each session has its own exposure. A subagent starts clean, and its own calls run under the root agent's policy against the subagent's exposure, not the parent's.

- **Child to parent.** Tag a subagent or remote agent that can read untrusted content with `reads:untrusted`, so calling it exposes the parent. The built-in `agent` tool counts as untrusted, because its copy has the parent's tools.
- **Parent to child.** An exposed parent asks before calling a subagent tagged `effect:external`. Nothing passes the parent's exposure into the child.

A subagent runs as a task. Its call settles, and exposes the parent, when its result is ready, so the parent's calls while it runs are decided on what the parent has read so far.

## Telemetry

`taintRuntimeContext()` returns `taint.exposed` and `taint.sources` (comma-joined, truncated to 256 characters) for [`runtimeContext`](./observability/otel#add-runtime-context):

```ts title="agent/instrumentation/traces.ts"
import { otelIntegration } from "eve/instrumentation/otel";
import { taintRuntimeContext } from "eve/extensions/taint";

export default otelIntegration({
  runtimeContext: () => taintRuntimeContext(),
});
```

The values reach only the AI SDK spans of each model attempt. Tool spans already carry the call's tags as `agent.tool.tags`.

## Timing

The extension's hook runs before eve continues past each event, so a call the model makes in a later step sees what earlier calls exposed. Calls in the same model response are approved together, so a call made alongside an untrusted read isn't gated by it. The model wrote both before it read the result.

## Limits

- A hook's write can be lost if a step is interrupted after the event is recorded and before the step's state is saved. `markOnRequest` narrows this for untrusted calls.
- Exposure doesn't pass from a parent to its subagents. It passes from a subagent to its parent only through the subagent's tags.
- Sessions that started before you mounted the extension aren't tracked.
- There's no live view of exposure for clients and no run-level tag in Agent Runs.
- An agent-wide `"user-approval"` can't carry a reason, so the approver sees the tool's own prompt.
- The policy doesn't gate provider-executed tools, `ctx.agent()` from workflow code, a remote agent's own calls, or memory recall.

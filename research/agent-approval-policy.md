---
issue: "#145, #2673"
status: proposed
last_updated: "2026-10-31"
---

# Agent-wide approval policy

## Problem

`approval` is declared per tool and per connection, and an omitted `approval` runs ungated. An
agent-wide rule ("deny `rm -rf` in `bash`", "ask before any destructive connection call") has to be
restated in every `agent/tools/*.ts`, every connection, and an override file for every built-in and
extension tool. Named subagents can't be gated at all, and anything added later (a new MCP
connection, a dynamic tool, a newly mounted extension) inherits nothing. The failure mode is
fail-open by omission.

## Authoring API

```ts title="agent/agent.ts"
import { defineAgent } from "eve";
import { auto } from "eve/tools/approval";

export default defineAgent({
  model: "anthropic/claude-sonnet-4.6",
  approval: auto(), // a decision model reviews every call
});
```

```ts title="agent/agent.ts"
export default defineAgent({
  model: "anthropic/claude-sonnet-4.6",
  approval: ({ toolName, toolInput }) => {
    if (toolName === "bash" && /\bgit\s+push\b/.test(String(toolInput?.command))) {
      return { type: "denied", reason: "Pushing is not allowed from this agent." };
    }
    if (toolName.startsWith("billing__")) return "user-approval";
    return undefined; // leave the entry's own decision
  },
});
```

`approval` is an ordinary `ApprovalPolicy`, the same type tools and connections use, so `always()`,
`once()`, `auto()`, and authored policies work unchanged. There's no object form: prompts and
response policies stay with the entry that asks.

## Semantics

- **Stricter wins.** For each call eve runs the agent's policy and the entry's own `approval` and
  takes the stricter status: denied, then user approval, then approved, then not applicable. The
  agent's policy can add a gate but never remove one. `undefined` leaves the entry's decision. A
  denial skips the entry's policy. On a tie the entry's status wins, so its `once()` memory, prompt,
  and response policy still apply.
- **One choke point.** The policy joins each entry's approval when the step catalog resolves it, so
  it covers every path that resolves through the catalog: direct calls, `eve__tool`, parked calls
  and their rechecks, and response policies. Covered: authored, built-in, extension, dynamic, and
  workflow tools, connection tools, declared and dynamic subagents, and the `agent` tool. A
  channel's direct `invokeTool` gets the same policy, so a call it would ask about is rejected with
  `approval-required`, as an entry's own `always()` is today.
- **Not covered.** Task controls (`eve__task_wait`, `eve__task_cancel`), catalog meta-tools
  (`eve__search`, `eve__skill`), connection sign-in entries, provider-executed tools, and
  `ctx.agent()` calls from workflow code. A child started by `ctx.agent()` is still governed: its
  own calls run under the root policy.
- **Subagents.** The root agent's policy applies in every local subagent session. A subagent's own
  `approval` joins it under the same stricter-wins rule, so no local subagent, including one an
  extension ships, can loosen the root's gates. A dynamic subagent config can't select one. A
  remote agent runs in its own deployment under that deployment's policy; the parent's policy gates
  only the call to it.
- **Connection pinning.** The joined policy runs inside the connection's instance pin, so a call it
  parks runs only against the instance it was approved for.
- **Fail closed at load.** A compiled agent that marks a policy the runtime can't load refuses to
  start rather than run ungated.

## Compile and runtime

Like `limits.sessionUsage`, the manifest only records `approval: true`; the runtime loads the
function from the agent config module.

## Out of scope and follow-ups

- **Loosening.** Bulk "never ask for this extension's tools" stays a per-tool override. A future
  mount-level option could cover it without letting the agent policy remove gates.
- **Entry kind on the context.** Extension tools (`crm__search`) and connection tools
  (`crm__delete_account`) share a naming shape. Exposing the entry's kind and owner would let rules
  stop depending on names.
- **Introspection.** `eve info` and `/eve/v1/info` report `approval` from each tool's own
  definition; they should also report an agent policy.
- **`ctx.agent()`.** Consulting the policy when workflow code starts a named subagent.

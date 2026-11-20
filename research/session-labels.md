---
issue: "TBD"
status: proposed
last_updated: "2026-11-03"
---

# Session labels

## Problem

Prompt injection ([OWASP LLM01:2025](https://genai.owasp.org/llmrisk/llm01-prompt-injection/)) can't
be reliably detected or removed from natural-language input. What an agent author _can_ control is
what a session is allowed to do once untrusted text is in its context. The highest-impact failures
need three things in one session:

1. it read untrusted content (an issue body, an inbound email, a web page, a chat message from
   anyone in a channel),
2. it can reach private data, and
3. it can change state or send data outside the session.

eve has no record of which of these a session has done. An `approval` policy sees `toolName`,
`toolInput`, and the session's caller, but not that this session read a public issue three steps
ago. Authors who want "ask a person before posting once the session has read untrusted input" have
to build it themselves with a `call.settled` hook and `defineState`. That breaks at the first
subagent, because state never crosses the parent and child boundary, so a child that read the issue
returns its answer to the parent clean. Every agent invents its own vocabulary, and nothing reaches
telemetry in a form an operator can query across agents.

Success looks like:

- An author tags tools once and writes one agent-wide policy that gates on what the session has
  read.
- A child's labels can't be laundered through its answer.
- Without any policy, an operator can still find "a session that read untrusted content then made an
  external call" in traces.

## Authoring API

Labels are strings. eve defines three well-known labels and accepts any other string for
agent-specific ones (`"customer-data"`, `"pii"`).

| Label       | Kind   | Meaning                                                           |
| ----------- | ------ | ----------------------------------------------------------------- |
| `untrusted` | read   | Content that someone outside the agent's trust boundary can write |
| `private`   | read   | Data that must not leave the agent's trust boundary               |
| `external`  | effect | The call changes state or sends data outside the session          |

A tool declares what reading its result adds to the session (`reads`) and what calling it does
(`effects`):

```ts title="agent/tools/read_issue.ts"
export default defineTool({
  description: "Read a GitHub issue.",
  inputSchema: z.object({ repo: z.string(), number: z.number() }),
  labels: { reads: ["untrusted"] },
  async execute({ repo, number }) {
    /* ... */
  },
});
```

```ts title="agent/tools/post_comment.ts"
export default defineTool({
  description: "Comment on a GitHub issue.",
  inputSchema: z.object({ repo: z.string(), number: z.number(), body: z.string() }),
  labels: { effects: ["external"] },
  async execute(input) {
    /* ... */
  },
});
```

When trust depends on the content, `reads` can be a function of the settled call. It can add labels
but can't remove a label the session already has:

```ts
labels: {
  reads: ({ output, session }) =>
    output.authorId === session.auth.current?.principalId ? [] : ["untrusted"],
},
```

Connections declare a default for their tools and per-tool overrides keyed by the server's tool
name:

```ts title="agent/connections/github.ts"
export default defineMcpClientConnection({
  url: "https://example.com/mcp",
  labels: {
    default: { reads: ["untrusted"], effects: ["external"] },
    tools: {
      list_labels: {},
      get_issue: { reads: ["untrusted"] },
    },
  },
});
```

Policies read the session's labels and the called entry's labels from `ApprovalContext`:

```ts title="agent/agent.ts"
export default defineAgent({
  model: "anthropic/claude-sonnet-4.6",
  approval: ({ session, toolLabels }) => {
    const exposed = session.labels.has("untrusted");
    const sensitive = session.labels.has("private");
    if (exposed && sensitive && toolLabels.effects.includes("external")) return "user-approval";
    return undefined;
  },
});
```

`eve/tools/approval` ships the common case so most agents don't write that function:

```ts
import { requireApprovalWhen } from "eve/tools/approval";

approval: requireApprovalWhen({ session: ["untrusted"], effects: ["external"] }),
```

Tools, hooks, and channel handlers read `ctx.session.labels` as well. `session.labels.sources(label)`
returns the `{ toolName, callId }` entries that added a label, for approval prompts and logs.

## Semantics

- **Inert until read.** Labels change no behavior on their own. Only a policy, a hook, or a tool that
  reads them acts on them. Adding labels to an existing agent is safe, and an agent can ship labels
  and telemetry first and enforcement later.
- **Monotonic for the session.** A label, once added, stays for the life of the session. Compaction,
  clear, and session handover keep it, because a summary of untrusted text is still untrusted. In this
  version the only way to drop labels is a new session.
- **Added when a result enters history.** `reads` apply when a call settles with output the model will
  read, errors included, and before the next model call. Calls that the same model response requested
  are evaluated against the labels from before that response, because the model had not seen the new
  results. Parked approvals re-check against the labels the session has at re-check time.
- **One choke point.** `toolLabels` resolve where the step catalog resolves `approval`, so they cover
  every path it does, including `eve__tool`, which reports the resolved entry's labels, not its own.
  The entries that [agent-wide approval](./agent-approval-policy.md) leaves ungated have no labels.
- **Policies see unlabeled entries.** An entry with no declared labels has
  `toolLabels.declared === false`. `requireApprovalWhen` treats an undeclared entry as having every
  effect it checks for, so a forgotten label fails closed for the stock policy. Hand-written policies
  choose for themselves.

### Defaults

| Entry                                     | Default labels                                                         |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| `web_fetch`                               | reads `untrusted`, effects `external`                                  |
| `web_search`                              | reads `untrusted`, effects `external`                                  |
| `bash`                                    | none under `deny-all`; otherwise reads `untrusted`, effects `external` |
| `read_file`, `write_file`, `glob`, `grep` | none (sandbox-local)                                                   |
| Connection tools                          | the connection's `default`, then MCP annotations, then undeclared      |
| Remote agents                             | reads `untrusted`, effects `external`, plus forwarded labels           |
| Authored tools                            | undeclared                                                             |

[MCP tool annotations](https://modelcontextprotocol.io/specification/2025-06-18/schema#toolannotations)
are declared by the server, so they can only add labels: `openWorldHint: true` adds `untrusted` reads
and `external` effects, and `readOnlyHint: false` adds `external`. A hint can never remove a label the
author declared.

### Subagents and delegation

```text
parent ── labels at dispatch ──▶ child (starts with them)
parent ◀── child's final labels ── child result (unioned into parent)
```

- **Down.** A local child, whether a declared subagent, a dynamic one, the `agent` tool, a task, or
  `ctx.agent()`, starts with its parent's labels at the moment of dispatch.
- **Up.** When a child's result settles in the parent, the parent gains every label the child ended
  with. Without this, a reader subagent launders what it read.
- **Declassification.** A tool can declare `labels: { declassify: ["untrusted"] }` only when it has an
  `outputSchema` whose leaves are all bounded (enums, numbers, booleans, or strings with a `pattern` or
  `maxLength`). eve refuses to load any other declaration. The result then contributes its child's
  labels minus the declassified ones. This turns "the reader returns a typed result checked in code" into
  a rule eve enforces. An attacker can still pick _which_ enum value comes back, but not inject free
  text.
- **Remote agents.** The caller sends its labels with the dispatch. The receiver accepts them only
  from a deployment its `trustedForwarders` approves, which is the same trust decision that covers trace
  content limits. As with those limits, each hop can add labels but never remove one. The receiver
  returns its final labels with the result. The caller unions them with the remote entry's own labels.

### Channel input

Turn input can carry labels. A channel handler, or a hook on `turn.started`, adds them for content
that arrives from outside the trust boundary, such as a webhook payload from a public repository.
Built-in channels add none in this version. Choosing their defaults is an open question.

## Observability

Labels are metadata: names, tool names, and call IDs, never content.

- **Spans.** `agent.step` and `execute_tool` spans record the session's labels at that point, and
  `execute_tool` spans record the entry's `reads` and `effects`. Approval spans record which labels
  the policy saw. Attribute names follow the existing schema 4 `agent.*` namespace and are settled
  with the implementation.
- **Run attributes.** eve writes `$eve.labels` through its reserved run attributes, so runs can be
  filtered by label without scanning spans.
- **Events.** The session stream gains a `labels.added` event with the label and its source, so hooks,
  frontends, and exporters can react without polling.

With no policy enforced, "an `execute_tool` span with `external` effects in a session labeled
`untrusted`" is already a query. That gives operators a dry run across every agent before anyone turns
on enforcement.

## Alternatives considered

- **Userland only** (a `call.settled` hook, `defineState`, and an agent policy). This needs no core
  change and works today for a single session. Rejected as the end state: state doesn't cross
  subagents, so labels launder through delegation; built-in and connection tools need hand-kept
  lists; and every agent emits different telemetry.
- **Value-level taint tracking.** Labels on each value, propagated through a planner the framework
  controls, sometimes with untrusted content hidden from the main model behind references. This is
  more precise and gates fewer calls. It requires eve to own the agent's control flow or rewrite what
  the model sees, which conflicts with a lean core and costs utility on ordinary tasks. Session labels
  don't rule it out later.
- **Detection only.** A classifier over tool results, or `auto()` on every call. This needs no
  labeling, but it is probabilistic and can't give an auditable reason. It complements labels: a
  policy can run `auto()` only when labels say the session is exposed.
- **Capability separation only.** Readers with no effects and writers that never see raw input. This
  is the strongest posture and the one labels are meant to support. On its own it gives no runtime
  check and no visibility when an agent drifts from the design.

## Out of scope and follow-ups

- **Confidentiality destinations.** Matching `private` data against who may read a destination (per
  principal or per audience) instead of a single `external` effect.
- **Memory.** Memory captured in a labeled session can carry injected text into later sessions.
  Labeling captured entries and re-adding the labels on recall needs its own design.
- **Built-in channel defaults.** For example, labeling content from authors other than the turn's
  principal in shared threads.
- **Label decay.** Dropping labels after clear or when the content is gone. This version keeps labels
  for the whole session on purpose.
- **Text-only manipulation.** Labels gate effects. They don't stop an injected document from skewing a
  summary that only the user reads.

## Rollout

1. Labels on entries, durable session labels, defaults, events, and telemetry. Everything stays inert
   and is exported as experimental.
2. `session.labels` and `toolLabels` on `ApprovalContext`, plus `requireApprovalWhen`.
3. Local subagent propagation and declassification.
4. Remote propagation and channel input labels.

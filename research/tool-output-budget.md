---
issue: "https://github.com/vercel/eve/issues/5924"
status: implemented
last_updated: "2026-11-12"
---

# Default tool output budget

## Problem

A tool result enters history at full size and is sent again on every later
model call. eve's built-in tools (`bash`, `grep`, `glob`, `read_file`,
`web_fetch`) bound their own output, and task results have their own budget,
but authored and MCP results were left to each tool. One oversized result (a
multi-megabyte API response, a whole file from an MCP server) is then resent on
every step until compaction's tool-result cap reaches it, brings the next
compaction forward, and, when it crosses the threshold on its own, forces a
full summary while it is still in the verbatim tail that the cap skips. MCP
tools have no `toModelOutput`, so they couldn't bound their results without
being replaced by an authored tool.

## Authoring API

One agent-level limit, beside the other runtime limits:

```ts title="agent/agent.ts"
export default defineAgent({
  model: "anthropic/claude-opus-5.5",
  limits: {
    toolOutputTokens: 4_000, // default 12_000 (about 48,000 bytes); false turns it off
  },
});
```

The unit is approximate tokens of four UTF-8 bytes, the ratio eve's other
limits use. The default is close to the Codex CLI's tool-output budget (10k
tokens plus a 20% allowance). Dynamic subagent configs accept the same field;
a static subagent uses its own `agent.ts` value or the default.

## Semantics

- **Where:** at the point a tool result becomes model text, after
  `toModelOutput`: an inline call's result (authored `execute`, authored
  `toModelOutput`, connection/MCP results, approved calls) and a workflow
  tool's result when it resumes the turn. History stores the bounded output,
  so the prompt, compaction's measurement, and the summarizer all read the
  same text the model saw.
- **What is cut:** text over the budget keeps its first and last halves of the
  room left after a single notice, cut on UTF-8 character boundaries; the
  notice counts toward the budget and names how many bytes were cut. A
  `content` output's text parts share one window and one notice; file parts
  are not counted and keep their own limits. JSON over the budget becomes text
  cut the same way; JSON within it keeps its shape. A failure stays a failure
  (`error-text`). Bounding is idempotent.
- **What is not cut:** the raw result on `call.settled` and in hooks, eve's
  own (framework) tools, whose truncation is line-aware and paging-aware, task
  and subagent results, which have their own budget, and provider-executed
  results, whose payloads a provider may need replayed verbatim.
- **`false`:** results reach the model whole, as before.

## Boundaries

History that already holds an oversized result from before this change is not
rewritten; compaction's existing cap still applies to it. Bounding at read time
instead (on every prompt projection) would cover that history, but would need
compaction's measurement, the usage baseline, and the committed history to all
switch to a projected view, a much wider change to the harness core for a
transitional case.

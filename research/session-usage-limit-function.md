---
issue: https://github.com/vercel/eve/pull/5028
status: implemented
last_updated: "2026-10-19"
---

# Session usage limit as a function

Three numeric caps (`maxInputTokensPerSession`, `maxOutputTokensPerSession`,
`maxTokenCostUsdPerSession`) could only express "this one counter crossed this
number". Authors who want to count cache writes, new input plus output, or a
mix of tokens and cost had no way to say so, and every new counting rule needed
another field.

Replace them with one authored function, shaped like a tool's `approval`
policy:

```ts
limits: {
  sessionUsage: ({ total, window }) => boolean, // true = limit reached
}
```

`total` is the session's lifetime usage; `window` is the usage since the last
approved continuation. Both are the shared `TokenUsage` record and include
delegated spend. Approving a continuation starts a new window, which replaces
the old "re-anchor each ceiling to usage + configured limit" bookkeeping with a
single stored snapshot. When omitted, the limit is 40M new input tokens
(`inputTokens - cacheReadTokens`) per window.

## Subagents

A function can't be divided the way a number can, so the per-step split of the
parent's remaining quota goes away. Each subagent session checks its own window
with its own `sessionUsage`, or the root agent's when it authors none. Child
spend still counts in the parent's usage once the child replies. Dynamic
subagent configs are serialized into workflow input, so they can't carry a
function and always use the root agent's.

## Runtime

The manifest marks `limits.sessionUsage: true`; the agent config module
becomes a runtime entry and the runtime loads the function when it resolves the
agent, the same way tool approval policies are loaded. The harness receives it
through its config, never through durable session state.

## Compatibility

This is a breaking change to `defineAgent`, made before 1.0 without a shim.
Sessions created before the change keep their stored numeric limits in durable
state, which the runtime now ignores; they start on the new limit with a window
covering their whole history. Pending continuation prompts from older
deployments still match the session-limit request id. The two failure codes
collapse into `SESSION_USAGE_LIMIT_REACHED`.

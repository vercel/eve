# Progressive code mode

## Enablement

Enable code mode once on the agent:

```ts
export default defineAgent({
  experimental: { codeMode: true },
  model: "openai/gpt-5.4",
});
```

There is no central tool list, environment switch, experiment arm, pin list,
or second discovery mode. Typed inline tools remain directly callable and also
enter the progressive `code_mode` catalog automatically. The same rule applies
after a dynamic tool resolver runs, so request-level visibility gates remain
authoritative.

## Selection rule

Selection depends on execution properties, not the application domain:

- Use code mode when later calls depend on earlier results.
- Use it when a result determines how many calls to make.
- Use it for deterministic loops, retries, filtering, validation, aggregation,
  or compact local reduction across several calls.
- Prefer direct tools for one call or a small fixed set of independent calls.
- Prefer direct tools when model judgment or user interaction is needed between
  calls.

If code mode is selected, call it once and put the complete deterministic
workflow in that program. Never wrap a single host call.

## Progressive catalog

The `code_mode` description lists the shortest exact input/output signatures
that fit in an approximately 2,000-token budget. A program searches the full
request-scoped catalog without leaving the sandbox:

```ts
const found = await search({ query: "lookup", limit: 10 });
const item = found.items[0];
const key = item.path.startsWith("tools.")
  ? item.path.slice(6)
  : JSON.parse(item.path.slice(6, -1));
return await tools[key](input);
```

## Runtime boundary

- First-party `@ai-sdk/code-mode` executes through its bundled Run runtime.
- 64 total bridge requests per program.
- 8 simultaneous bridge requests.
- 300-second outer timeout.
- No sandbox fetch, imports, timers, process, environment, or host filesystem.
- Nested output is schema-validated before generated code receives it.
- Code receives typed raw output; direct calls still use `toModelOutput`.
- Nested leaf calls emit ordinary `actions.requested` and `action.result`
  events; internal catalog searches do not appear as domain tool calls.
- Approval, authorization, background work, delegation, and control-plane tools
  remain direct.
- The outer call has ordinary Eve tool retry and replay semantics.
- Host calls must honor their own timeout and abort behavior.

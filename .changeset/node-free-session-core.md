---
"eve": patch
"@vercel/agent-runs": patch
---

eve's session core and harness use fewer Node built-ins and globals, and `@vercel/agent-runs` no longer needs `node:crypto`; behavior on Node is unchanged.

Each runtime-specific module under `src/runtime-env/` has a Node version and a web version, chosen at build time by the `node` export condition. A runtime without `AsyncLocalStorage` runs a step's tool calls one at a time.

Thanks @OwenKephart for the original implementation in #6074.

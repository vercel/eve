---
"eve": minor
---

Forward just-bash `SandboxOptions` through the `justbash()` backend via `JustBashSandboxCreateOptions`, and enable its bundled interpreters.

- Execution controls the backend previously hardcoded or omitted: `timeoutMs`, `maxCallDepth`, `maxCommandCount`, `maxLoopIterations`, and `defenseInDepth`.
- Bundled-interpreter capability flags `python` (stdlib-only CPython via WebAssembly) and `javascript` (js-exec via QuickJS), both off by default. Passing `justbash({ python: true })` now runs `python3` in the sandbox, closing #431.

Each field is optional and falls back to just-bash's own default when omitted, so existing apps are unaffected.

**Requires `just-bash@^3.1.0`** (the peer floor is raised from `^3.0.0`). This is load-bearing, not housekeeping: `python`/`javascript` only reach the interpreter through `Sandbox.create` as of just-bash 3.1.0 (vercel-labs/just-bash#284). On older just-bash they are silently dropped — `python: true` would no-op rather than error — so the version floor is the only guard against that silent failure.

The remaining just-bash capability flags (`commands`, `customCommands`, `fetch`) are intentionally not surfaced: their just-bash types cannot be honestly restated as primitives, and exposing them would put just-bash's types on eve's public API (the same reason `defenseInDepth` is narrowed to a plain boolean).

---
"eve": minor
---

Forward the just-bash `SandboxOptions` that the `justbash()` backend previously hardcoded or omitted — `timeoutMs`, `maxCallDepth`, `maxCommandCount`, `maxLoopIterations`, and `defenseInDepth` — through `JustBashSandboxCreateOptions`. Each is optional and falls back to just-bash's own default when omitted, so existing apps are unaffected. (The bundled-interpreter capability flags like `python` are not reachable through `Sandbox.create` and remain gated upstream — see vercel-labs/just-bash#284.)

---
"eve": patch
---

Vercel builds now run a single Nitro build. The workflow flow function is emitted through Nitro's per-route `functionRules` (queue trigger, `maxDuration: "max"`, precondition guard) instead of a second standalone Nitro build that was copied and retargeted into the output, making `eve build` on Vercel roughly twice as fast.

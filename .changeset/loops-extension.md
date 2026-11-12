---
"eve": patch
---

Add `eve/extensions/loops`, a built-in extension that notices when a turn repeats the same tool calls without progress, nudges the model to change approach, and stops the turn if the loop comes back.

Mount it with `export default loops({})` in `agent/extensions/loops.ts`. It detects the same call returning the same result, two calls alternating, and one call repeated within a window, with thresholds you can tune or turn off. It adds no tools and changes nothing for a turn that doesn't loop.

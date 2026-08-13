---
"eve": minor
---

Instrumentation now records trace metadata without model or tool inputs and outputs by default. Set `recordInputs` or `recordOutputs` to `true`, or use `EVE_TRACES_CONTENT=on` for the automatic local trace spool, to opt into content capture.

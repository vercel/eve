---
"eve": minor
---

`CallObservation` (`eve/events`) and `EveToolPart` (`eve/client` and framework bindings) now expose `parentCallId` for calls run inside another call, and the dev TUI, web chat registry, and framework UIs group nested calls under their parent call.

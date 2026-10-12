---
"eve": minor
---

Migrate v27 conversation producers and readers to explicit delivery, turn, model, content, call, context-change, and usage facts. Reply content is distinguished from narration, delivery settlements determine response completion, and readers finish the current commit before stopping. Turn and session failure/cancellation close the open work found in the shared session view, preserving task work that can outlive a turn. Operational views retain ownership ancestors while their descendants remain open.

Usage is recorded per model run or delegated call rather than copied onto turn/session terminal events. Eval turn usage remains the captured session's total so far, including compaction summaries and delegation. Late spend from a resumable tool after its calls have settled is recorded separately without claiming call ownership. Errors expose a code, message, optional support id, and optional remediation hint; channel contexts expose the fact's optional scope.

Hook, channel, and schedule extension epochs that used the v26 conversation event contract are no longer accepted. Migrate event handlers to the v27 facts in `eve/events` and rebuild extensions; the compiler reports the dropped epoch and migration reason. Stored lines are limited to 8 MiB in UTF-8, below the workflow writer's chunk limit. Oversized commits fail before writing and are never split.

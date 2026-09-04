---
"eve": minor
---

Remove Workflow hook metadata and session inbox version negotiation to avoid metadata hydration during hook resumes. Restart sessions pinned to older inbox wire formats when upgrading; replay of older persisted payloads remains supported.

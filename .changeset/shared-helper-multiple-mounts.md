---
"eve": patch
---

Fix `eve build` failing with "refers to multiple extension mounts" when the code or git extension is mounted on more than one agent and the app uses `installCodeTooling` or mounts both extensions.

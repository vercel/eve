---
"eve": patch
---

just-bash sessions now keep their sandbox files after a deployment that changes the sandbox template, such as adding a skill. Previously, every sandbox call in an existing session failed with "just-bash session state is incompatible with this environment."

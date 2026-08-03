---
"eve": patch
---

Skill file reads now resolve `$HOME/.agents/skills/<skill>/` first and fall back to `/workspace/skills/<skill>/`, as the docs and system prompt already describe. Previously `read_file` resolved a single root and hard-failed when the model named the other one, forcing a wasted retry.

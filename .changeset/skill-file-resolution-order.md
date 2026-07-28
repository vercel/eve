---
"eve": patch
---

Resolve skill file reads in the documented order: `$HOME/.agents/skills/<skill>/` first, with `/workspace/skills/<skill>/` as the fallback. `read_file` now accepts the symbolic `$HOME/.agents/skills/...` form and falls back across skill roots instead of failing when the model names the workspace path.

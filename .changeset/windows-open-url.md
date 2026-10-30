---
"eve": patch
---

`eve` setup now opens browser URLs on Windows through `rundll32` instead of `cmd /c start`, so `&` or `|` in a URL is no longer interpreted by the shell.

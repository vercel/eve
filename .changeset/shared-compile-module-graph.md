---
"eve": patch
---

`eve build` and `eve dev` now evaluate a module shared by several tools, channels, or other authored files once per compile instead of once per importing file. Compile memory now grows with the code an agent actually has, not with the number of files that import it, so agents with many tools over a shared SDK or workspace package no longer run out of memory on smaller build machines.

---
"eve": patch
---

Dev runtime generations now retain the compiled authored module graph instead of recursively copying the app and workspace source trees. Local rebuilds keep immutable runtime behavior while using substantially less disk space.

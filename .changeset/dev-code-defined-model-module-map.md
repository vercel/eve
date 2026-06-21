---
"eve": patch
---

Fix code-defined models under `eve dev`, including NodeNext `.js` imports that target authored `.ts` files. Runtime model resolution now reuses the active agent bundle's module map and node scope, so child agents resolve their own models without rebuilding authored modules on each step.

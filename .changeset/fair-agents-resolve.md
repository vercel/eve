---
"eve": patch
---

Fix project discovery for directories named `agent` that contain their own project manifest. Nested and flat projects now resolve within that directory instead of being assigned to an ancestor or failing because the ancestor has no agent files.

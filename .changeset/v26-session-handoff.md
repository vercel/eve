---
"eve": patch
---

Eligible idle sessions owned by an eve 0.82 or 0.83 deployment can now move to a deployment running this release, preserving their v26 history and appending new turns in v27. Sessions with in-flight work, incompatible channel state, or a parent or remote caller stay on their old deployment; migrated sessions discard remembered `once()` approvals and ask for consent again when required.

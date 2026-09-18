---
"eve": patch
---

Fix `eve dev` and `eve invoke` for an agent workspace member that mounts an extension with subagents. The development runtime snapshot rewrote compiled-manifest roots only when they sat inside the member app root, so an extension resolved from the workspace's `node_modules` kept its real path and the snapshot validator rejected it with "Development runtime snapshot manifest root ... is outside runtime app root ...". Roots outside the app root are now rewritten against the snapshot source root, where the snapshot already mounts the workspace install.

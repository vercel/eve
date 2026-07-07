---
"eve": patch
---

Session sandboxes are now keyed per durable session instead of per deployment, so redeploying no longer discards a session's `/workspace` state. A session gets a fresh sandbox only when the sandbox definition itself changes (authored sandbox source, workspace seed content, or `revalidationKey`), and `onSession` runs again on the replacement sandbox.

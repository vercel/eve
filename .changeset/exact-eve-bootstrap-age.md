---
"eve": patch
---

Apply release-age policies during project and extension setup instead of bypassing them. New standalone pnpm projects use strict enforcement, while projects inside an existing workspace retain that workspace's policy.

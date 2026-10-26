---
"eve": patch
---

Declare `next` as an optional peer dependency, so `eve/next` types resolve the app's own `next` in pnpm workspaces that install more than one `next` version. Thanks @laugharn for reporting this in #5341.

---
"eve": patch
---

eve now targets Node.js 26: new projects pin `engines.node` and `@types/node` to `26.x`, so Vercel deploys them on the `nodejs26.x` runtime, and the default sandbox image and generated Discord relay Dockerfile run Node.js 26.

eve still supports Node.js 24 and later. When eve updates the `package.json` of an existing project that pins `engines.node` to another major, such as `24.x`, it now sets `26.x` and prints a warning.

---
"eve": patch
---

Make `npx eve@latest` start much faster with npm by no longer declaring `@vercel/connect` as an optional peer dependency, which made npm download about 450 MB of package metadata it never installs.

eve uses its own bundled copy of `@vercel/connect`. Projects that import `@vercel/connect/eve` still need `@vercel/connect` 2.7.0 or later installed, and `eve init` already adds it.

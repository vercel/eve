---
"eve": patch
---

Set `minimumReleaseAge: 0` in newly generated pnpm workspace files so dependencies installed by `eve init` also pass pnpm's checks when starting the dev server or installing again.

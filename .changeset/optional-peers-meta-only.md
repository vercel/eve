---
"eve": patch
---

Make `npx eve@latest` start faster with npm by declaring eve's optional peer dependencies without version ranges, which stops npm from downloading the metadata of every framework eve integrates with.

pnpm and Yarn still link these packages from your app, as before. They no longer check your installed version against a range, so install a version listed in the TypeScript API reference.

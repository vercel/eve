---
"eve": patch
---

`eve add channel/web` now asks which framework Web Chat uses and can install a TanStack Start app under `apps/web/`, hosted as a separate Vercel service or inside the app through `eve/tanstack`; non-interactive installs keep Next.js unless you pass `--answer 'web-framework="tanstack"'`. Web Chat setup also checks for authored configuration before writing, removes the `vercel.ts` and scripts it wrote when you switch hosting modes, and renders text in the loaded Geist fonts.

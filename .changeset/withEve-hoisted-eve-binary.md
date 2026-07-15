---
"eve": patch
---

Fix `withEve` producing a broken Vercel build command under npm workspaces, where eve is hoisted to the workspace root rather than the app's own `node_modules`. The eve binary is now located via module resolution, so npm-hoisted and pnpm layouts both work.

---
"eve": patch
---

Next.js-hosted Web Chat in `apps/web` now deploys to Vercel.

`eve add channel/web` with Next.js hosting now writes a root `vercel.json` that builds `apps/web` and serves `apps/web/.next`. Before, Vercel ran the root `eve build` script and failed with "The Next.js output directory `.next` was not found". An existing authored `vercel.json` or `vercel.ts` is left as it is, and switching to Vercel services replaces the installer's `vercel.json` with `vercel.ts`.

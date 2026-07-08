---
"eve": patch
---

Update `withEve()` to generate Vercel Build Output service routes for eve instead of the legacy Next.js rewrite setup. The generated output now uses the stable `services` field and service routes, including in hosted Vercel builds where no local `.vercel/project.json` exists, so Vercel builds the eve service without Next.js rewrites.

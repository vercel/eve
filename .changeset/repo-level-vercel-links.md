---
"eve": patch
---

Detect Vercel projects linked at the repository level (`.vercel/repo.json`, written by the Vercel CLI's "linked by git" flow). Previously eve only read `.vercel/project.json`, so `eve channels add slack` on a git-linked project failed with "Vercel project linking failed" even though `vercel link` succeeded; the link-fallback error now also explains how to recover when no on-disk link can be detected.

---
"eve": patch
---

Preserve authored Vercel Git deployment policy when building eve apps on Vercel. Static `vercel.json` and `vercel.ts` configs with `git.deploymentEnabled` are copied into the generated framework output so Vercel can honor disabled preview branches for eve projects.

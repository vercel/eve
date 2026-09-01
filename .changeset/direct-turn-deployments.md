---
"eve": patch
---

Route per-turn workflows directly to the Vercel deployment that accepted a delivery when the session driver is already running there, avoiding unnecessary latest-deployment resolution while preserving the existing fallback across deployments.

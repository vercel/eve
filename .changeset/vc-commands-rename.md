---
"eve": patch
---

The dev TUI's `/vc` and `/login` commands are now `/vc:install` and `/vc:login`. `/vc:login` is the single Vercel authentication command: it logs in locally and, in remote (`eve dev --url`) sessions, recovers access with Vercel OIDC.

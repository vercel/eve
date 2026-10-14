---
"eve": patch
---

Vercel sandbox creation now reads `VERCEL_TOKEN`, `VERCEL_TEAM_ID`/`VERCEL_ORG_ID`, and `VERCEL_PROJECT_ID` from the environment, like sandbox lookup and deletion already do. A CI runner without a linked project can now create sandboxes.

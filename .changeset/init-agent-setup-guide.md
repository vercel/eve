---
"eve": patch
---

`eve init` with no target, when run by a coding agent, now prints a setup guide — what to ask the user, then the scaffold command — instead of scaffolding the current directory. The guide routes both channels (Slack credentials) and connections (per-user OAuth) through Vercel Connect so credentials are provisioned rather than hand-managed. `eve init <name>` and `eve init .` are unchanged.

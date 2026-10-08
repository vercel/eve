---
"eve": patch
---

Configure 100% trace sampling when creating a Vercel project during setup, including `/model` and non-interactive `eve link`, so traces appear in Agent Runs. Existing projects keep their sampling settings, and `eve deploy --no-trace-sampling` still skips configuration.

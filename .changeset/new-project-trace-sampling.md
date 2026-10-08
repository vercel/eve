---
"eve": patch
---

Configure 100% trace sampling when eve creates a Vercel project during `eve link`, `eve deploy`, or integration setup, so traces appear in Agent Runs. Existing projects keep their sampling settings, and `eve deploy --no-trace-sampling` still skips configuration.

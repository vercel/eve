---
"eve": patch
---

Update the bundled Workflow runtime to 5.4.0.

Workflow 5.4.0 resumes a parent run once when a child run finishes instead of polling in a step, honors abort signals when waiting for a run to finish on the Vercel World, and recovers Hook token claims left by a crashed process right away on the local World instead of after 30 seconds.

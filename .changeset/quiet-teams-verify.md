---
"eve": patch
---

Remote evals now resolve Vercel deployments using the owner and project from the environment or local project link, allowing protected deployments owned by a different team than the CLI's current team. Ambient credentials are withheld when the deployment does not match the expected project.

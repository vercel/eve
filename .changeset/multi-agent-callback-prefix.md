---
"eve": patch
---

Fix connector authorization and remote-subagent result callbacks 404ing in multi-agent mode (`withEve({ agents })`). Framework-minted callback URLs now include the agent's public route prefix (`/eve/agents/<name>`), so after connecting a provider or when a remote subagent finishes, the parked turn resumes instead of the connect card re-prompting in a loop or the parent turn hanging.

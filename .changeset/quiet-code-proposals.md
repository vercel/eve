---
"eve": minor
---

`eve/self-modification/remote` now delegates to an eve-code coding subagent that proposes changes as draft PRs without updating the running agent. The mount takes an `authorize` callback, `github: { repository, connector }` for a Vercel Connect connector, and optional `directory` and `baseBranch`. The former `source`/`target`/`credentials` configuration, PAT option, and custom publisher are removed.

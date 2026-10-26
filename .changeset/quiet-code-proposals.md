---
"eve": minor
---

`eve/self-modification/remote` now delegates to a coding subagent built on `eve/extensions/code` and `eve/extensions/git` that proposes changes as draft PRs on Vercel Sandbox without updating the running agent. The mount takes an `authorize` callback, `github: { repository, connector }` for a Vercel Connect connector, and optional `directory` and `baseBranch`; the former `source`/`target`/`credentials` configuration, PAT option, and custom publisher are removed. Guided setup now checks whether the base branch requires pull requests and strongly recommends a ruleset when it can't confirm one.

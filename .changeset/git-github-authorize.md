---
"eve": minor
---

`git({ github })` accepts an optional `authorize` callback. It runs before each `gh` command with the session's caller, the declared repository, and the repository-scoped token, and denies the command when it returns `false`. Use it to limit which callers can reach which repositories beyond the GitHub App installation, for example with an env var allowlist or a GitHub team lookup.

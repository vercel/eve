---
"eve": minor
---

The `gh` tool takes an optional `repository` instead of `permissions`, accepts any `gh` or `git` subcommand, and leaves every access decision to `github.authorize`.

`repository` is the `owner/name` a command acts on, or an owner for discovery such as `gh repo list <owner>`; user-scoped agents may omit it. `authorize` now receives `{ argv, auth, owner, repository, token }`, where `owner` and `repository` may be `null`, so update policies that assumed a string `repository`. eve no longer matches explicit targets such as `--repo` against the declaration or restricts `git` to `fetch`, `ls-remote`, `pull`, and `push`; check `argv` in `authorize` if your policy depends on them. App tokens are scoped to the repository when one is set and to the owner's installation otherwise.

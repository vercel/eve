---
"eve": minor
---

The `gh` tool takes an optional `repository` instead of `permissions`, runs any `gh` or `git` subcommand, and leaves every access decision to `github.authorize`.

`github.principalType` is now required and decides what `authorize` receives: `{ argv, auth, owner, repository, token }` for `"app"`, and `{ argv, auth, repository, token }` for `"user"`, where `repository` may be `null`. eve no longer matches `--repo` and other explicit targets against the declared repository or limits `git` to `fetch`, `ls-remote`, `pull`, and `push`; check `argv` in `authorize` if your policy depends on them.

---
"eve": minor
---

`executeGitHubShell` now throws `GitHubCommandInputError` when a command's own input is refused, so a custom GitHub tool can tell the agent's mistakes from real failures.

Shell syntax, an invalid repository, a `workingDirectory` outside the workspace, a `gh-signed-commit` directory that is not a repository root, and a missing `--body-file` used to throw a plain `Error`, like a missing configuration or an empty Connect token. Detect the new error with `isGitHubCommandInputError(error)` from `eve/extensions/git/sandbox`; its messages are unchanged.

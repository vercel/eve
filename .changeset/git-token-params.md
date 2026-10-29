---
"eve": patch
---

`git({ github: { principalType: "user" } })` runs `gh` commands with the caller's own GitHub permissions.

The `gh` tool resolves the caller's token from `github.connector` through `ctx.getToken`, so eve signs the caller in when needed and again when GitHub rejects the token. Without it, or with `principalType: "app"`, commands keep using the GitHub App installation token.

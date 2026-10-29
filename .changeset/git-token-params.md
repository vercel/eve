---
"eve": minor
---

`git({ github: { auth } })` runs `gh` commands with the caller's own GitHub permissions. It returns a user-scoped provider, such as `connect({ connector, tokenParams })`, that the tool resolves through `ctx.getToken`, so eve signs the caller in when needed and again when GitHub rejects the token. Without it, commands keep using the GitHub App installation token.

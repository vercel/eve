---
"eve": minor
---

`git({ github })` now requires an `authorize` callback as its only repository access control, drops `org`, and adds `principalType: "user"` to run `gh` commands with the caller's own GitHub permissions.

To migrate, remove `github.org` and move the restriction into `authorize`, for example `authorize: ({ repository }) => repository.toLowerCase().startsWith("acme/")`. Each command still declares one `owner/name` repository; app tokens are scoped to that repository in its owner's installation.

With `principalType: "user"`, the `gh` tool resolves the caller's token through `ctx.getToken`, so eve signs the caller in once for every repository and again when GitHub rejects the token.

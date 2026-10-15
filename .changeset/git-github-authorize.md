---
"eve": minor
---

`git({ github })` accepts an optional `authorize` callback that runs once per `gh` tool invocation with the caller, declared repository, and repository-scoped token; returning `false` blocks the command. It gates caller/repository access, not individual API requests or operations, and allowed commands use the app token's permissions rather than the caller's GitHub permissions.

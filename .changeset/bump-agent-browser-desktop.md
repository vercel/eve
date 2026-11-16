---
"@eve/agent-browser": minor
"@eve/agent-desktop": minor
---

`@eve/agent-browser` now targets agent-browser 0.43.0 and `@eve/agent-desktop` now targets agent-desktop 1.3.1.
Sandbox templates that include the revalidation keys rebuild with the new CLIs. With `autoInstall`, `@eve/agent-browser` reinstalls an older default install on the next tool call; a custom `installSpec` or `binary` must install agent-browser 0.43.

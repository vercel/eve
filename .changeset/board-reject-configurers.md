---
"@eve/board": patch
---

Fail config validation with a migration message when an `@eve/board` mount still sets the removed `configurers` option, instead of silently ignoring it. Move the allowlist into an `authorize` callback.

---
"eve": patch
---

Importing `eve/next` from a `node -e` script, such as the loader `vercel dev` uses for `next.config.*`, no longer throws `ERR_INVALID_ARG_VALUE` for `"[eval]"`.

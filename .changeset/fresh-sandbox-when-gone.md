---
"eve": patch
---

A session whose sandbox is gone (for example after a microsandbox daemon restart, a removed Docker container, a deleted Vercel Sandbox, or a deleted just-bash session directory) now starts a fresh sandbox on its next `ctx.getSandbox()`. Previously every sandbox call in that session failed with the same resume error until the session ended. Thanks @bradhallett for reporting this in #5113 and @moinulmoin for the just-bash case in #4440.

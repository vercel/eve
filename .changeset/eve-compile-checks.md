---
"eve": minor
---

The compile behind `eve info`, `eve build`, and `eve dev` now catches common agent mistakes that used to fail only at runtime or never.

Errors cover tool input schemas that model providers reject, `ctx.agent("name")` calls to agents a workflow tool can't reach, step-only context calls such as `ctx.getSandbox()` in a `"use workflow"` body, and connection approvals that compare `toolName` to a name the connection never produces. Warnings suggest the intended name for misspelled agent directories and files, and flag ignored `.tsx` and `.jsx` tool and hook files, agent files under `src/`, a `build` script that runs only `tsc`, a `next.config` without `withEve()`, and required env vars missing from `.env.example`. A Zod root union of objects is now sent to the model with `type: "object"`, which providers require.

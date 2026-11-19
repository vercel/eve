---
"eve": minor
---

The compile behind `eve info`, `eve build`, and `eve dev` now catches common agent mistakes that used to fail only at runtime or never.

Errors cover tool input schemas whose root isn't an object, `ctx.agent("name")` calls to agents a workflow tool can't reach, and connection approvals that compare `toolName` to a name the connection never produces. Warnings suggest the intended name for a misspelled agent directory and flag agent files under `src/`, a `build` script that runs only `tsc`, and a `next.config` without `withEve()` when no script runs eve. A Zod root union of objects is now sent to the model with `type: "object"`, which providers require.

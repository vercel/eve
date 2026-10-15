---
"eve": patch
---

Parse a workflow tool's result as JSON when its run completes, the way a local tool's result already is. A tool that returns `ctx.ask()`'s answer directly, after the person picked an option, no longer fails the turn with `Cannot convert undefined or null to object`: undefined properties are omitted, a tool that returns nothing reports `null`, and the same applies to `ctx.reply()` in `serve` tools. A result JSON can't carry, such as a `Date` or `Map`, now fails the call with a serialization error instead of reaching the model as `{}`.

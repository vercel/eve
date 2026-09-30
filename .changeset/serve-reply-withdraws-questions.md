---
"eve": patch
---

`ctx.reply()` in a `serve` workflow tool now withdraws the `ctx.ask()` questions still pending for the calls it settles, so they resolve as `cancelled` and channels stop offering them. Before, such a question stayed pending after its call had a result: it kept steering from interrupting a model step and could take the person's next plain message as its answer.

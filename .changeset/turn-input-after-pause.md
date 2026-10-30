---
"eve": patch
---

`ctx.turn.input` keeps the turn's input after the turn pauses for an approval, a question, a sign-in, or a budget answer.

Dynamic values no longer see empty input after the pause, including `auto()` if its per-turn memo was invalidated.

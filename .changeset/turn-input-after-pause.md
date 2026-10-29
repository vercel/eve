---
"eve": patch
---

`ctx.turn.input` keeps the turn's input after the turn pauses for an approval, a question, or a sign-in.

It used to read empty for the rest of the turn, so a dynamic value or `auto()` evaluated after the pause saw no input.

---
"eve": patch
---

The session budget prompt holds the turn open (`turn.waiting` with `on: "input"`) instead of completing it. Approve runs the held model call in the same turn, Stop answers the prompt once and cancels the turn, cancelling the turn withdraws the prompt, and a message that doesn't answer it is received into the held turn without starting a step, and read after Approve. A late answer to a budget prompt that already closed is dropped instead of reaching the model as text.

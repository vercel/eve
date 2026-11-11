---
"eve": minor
---

Tools in `agent/tools/` accept `enabled`, a function eve calls before each model call to decide whether the model is offered the tool, so a workflow tool can join only the calls that should offer it.

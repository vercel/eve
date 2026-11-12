---
"eve": patch
---

Sessions store much less as conversations grow: each session step now returns its changed values as frozen immer versions of the values it was given, so Workflow stores each step's input as a reference and its output as only what changed, instead of a full copy of the history every step.

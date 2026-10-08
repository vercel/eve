---
"eve": patch
---

`eve__tool` now runs a tool from the agent's tool list, other than eve's own catalog and task tools and tools a provider runs, instead of returning an error, so a model that routes a listed tool through it no longer wastes a step.

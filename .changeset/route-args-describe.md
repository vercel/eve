---
"eve": patch
---

Channel route handlers now receive `describe()`, which returns the agent's name, description, and the compiled tools a caller can run outside a turn, with their JSON schemas, without the inspection detail of `GET /eve/v1/info`.

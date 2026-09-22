---
"eve": patch
---

Defer sandbox environment preparation during development until the first sandbox access, so startup and rebuilds no longer wait for optional engine installation. First access prepares all environments in that compiled generation, with heartbeat-backed coordination that recovers after a development worker crash; production builds still prepare eagerly.

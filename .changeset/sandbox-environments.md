---
"eve": minor
---

Replace object-form sandbox definitions with exported provider environments whose `create()` and `getOrCreate()` methods return persistent live sandboxes. Built-in and custom providers now share `defineSandboxProvider()`, build-time provider artifacts are handed directly to runtime creation, Docker and microsandbox support images, Dockerfiles, and read-only resource mounts, and the agent info payload is version 5.

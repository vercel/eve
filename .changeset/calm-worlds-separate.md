---
"eve": patch
---

Prevent importing `eve/next` or `eve/nuxt` from initializing eve's bundled Workflow runtime. Application workflow integrations can now select their own Workflow World without config-time global resolver collisions.

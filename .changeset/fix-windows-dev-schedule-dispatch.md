---
"eve": patch
---

The `eve dev` schedule dispatch route now reuses the module loader path resolved when the server is built, preventing module resolution failures in the bundled Windows dev server.

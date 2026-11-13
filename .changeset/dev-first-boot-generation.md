---
"eve": patch
---

Fix `eve dev` failing requests that arrive during startup with a `LoadCompiledManifestError`.

The dev server now publishes the first agent build before its first worker serves, so those requests wait for the build instead of failing.

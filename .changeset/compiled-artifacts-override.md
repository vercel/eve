---
"eve": minor
---

Add `eve/internal/compiled-artifacts-override`, a hook that lets one deployment serve several compiled agents. `resolve(request)` picks the compiled artifacts a request runs, and `materialize(source)` writes them back before a Workflow step resumes on an instance whose disk no longer has them, so the step no longer fails with `LoadCompiledManifestError`. The hook is internal and unstable.

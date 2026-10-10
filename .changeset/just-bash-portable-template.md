---
"eve": patch
---

just-bash sandboxes now start when the app runs from a different path than the one it was built in. The prepared artifact stores the template key, and eve resolves it under the runtime sandbox cache, so copying `.output` and `.eve/sandbox-cache` to a new root no longer fails with `SandboxTemplateNotProvisionedError`.

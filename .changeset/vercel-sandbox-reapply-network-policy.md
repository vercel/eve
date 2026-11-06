---
"eve": patch
---

Vercel sandboxes created without a snapshot now get their configured network policy whenever a session opens them, including after an earlier open stopped between creating the sandbox and applying the policy.

Before, eve applied the policy only on the open that created the sandbox, so a sandbox left behind by an interrupted first open kept the open network access it uses for base setup. An open that can't apply the policy to an existing sandbox now fails instead of returning it.

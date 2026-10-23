---
"eve": patch
---

Prewarmed sessions now start the agent's sandbox before the first message, so the first turn resumes a running sandbox instead of creating one. The `defineSandbox()` selector of a prewarmed session runs with the auth of the request that created the session, and a failed start falls back to starting the sandbox on first use.

---
"eve": patch
---

Fixed a session on `VercelSandbox` failing every turn after its stopped sandbox's snapshot expired. eve now starts a fresh sandbox for the session, as it does when the sandbox is gone.

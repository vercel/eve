---
"eve": patch
---

Keep one session token-limit prompt pending while concurrent input queues behind it. Approving restores the configured budget window, delegated sessions inherit from the fresh window, and zero-quota child tasks no longer raise continuation prompts that cannot grant tokens.

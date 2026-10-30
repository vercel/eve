---
"eve": patch
---

Postgres and other custom Workflow worlds can now authenticate queue deliveries: set `EVE_WORKFLOW_DELIVERY_SECRET` and eve signs each queued job and rejects forged deliveries to `/.well-known/workflow/v1/flow`.

Without the variable, these worlds keep accepting unauthenticated deliveries, and eve prints a startup warning. To turn authentication on, generate a random value of at least 32 characters (for example with `openssl rand -hex 32`), set it on every server process connected to the world, and restart them together. Jobs queued before the secret was set fail with HTTP 401 until the world stops retrying them; at startup, eve queues active runs again with a current signature.

Each job stores a signature of its own queue name and message, not the secret, so the queue, its logs, and its backups cannot be used to forge new deliveries. Deliveries without a valid signature receive HTTP 401, whether the world delivers them in-process or over HTTP. To rotate the secret, set `old_secret,new_secret` everywhere, then `new_secret,old_secret`, then remove the old secret once its jobs have finished. With the secret set, worlds that enable experimental `invoke()` delivery are rejected at startup, because that path skips the signed queue.

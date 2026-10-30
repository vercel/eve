---
"eve": minor
---

Postgres and other custom Workflow worlds now require `EVE_WORKFLOW_DELIVERY_SECRET`, which eve uses to sign queued workflow jobs and reject forged deliveries to `/.well-known/workflow/v1/flow`.

Before upgrading, generate a random value of at least 32 characters (for example with `openssl rand -hex 32`) and set it on every server process connected to the world. The server exits at startup when it is unset. Jobs queued before the upgrade carry no signature and fail with HTTP 401 until the world stops retrying them. The built-in local world and Vercel Workflow need no configuration. When it is unset, `eve dev` and a local `eve eval` share a generated secret stored in `.eve/`.

Each job stores a signature of its own queue name and message, not the secret, so the queue, its logs, and its backups cannot be used to forge new deliveries. Deliveries without a valid signature receive HTTP 401, whether the world delivers them in-process or over HTTP. To rotate the secret, set `old_secret,new_secret` everywhere, then `new_secret,old_secret`, then remove the old secret once its jobs have finished. At startup, eve queues active runs again with a current signature. Worlds that enable experimental `invoke()` delivery are rejected at startup, because that path skips the signed queue.

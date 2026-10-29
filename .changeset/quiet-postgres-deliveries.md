---
"eve": patch
---

Authenticate queue deliveries for Postgres and other custom Workflow worlds with a shared secret, supporting both in-process workers and HTTP delivery between replicas.

Set `EVE_WORKFLOW_DELIVERY_SECRET` to the same random value of at least 32 characters on every producer and execution server before upgrading. Production startup fails when it is unset. The built-in local world and Vercel Workflow keep their existing delivery authentication.

For rotation, first deploy `old_secret,new_secret` to all receivers, then switch producers to `new_secret,old_secret`. Remove the old secret after all producers have switched and jobs using it have finished. Queue storage contains the delivery secret, so protect the database and its backups accordingly. `eve dev` and local `eve eval` generate a session secret when none is configured.

Jobs queued without a valid secret receive HTTP 401. eve re-enqueues active runs with the current secret at startup; existing eve-version compatibility rules still apply. Worlds with experimental `invoke()` delivery enabled are rejected at startup because that path bypasses authenticated enqueueing.

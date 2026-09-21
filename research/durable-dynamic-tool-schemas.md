---
issue: https://github.com/vercel/eve/issues/3019
status: implemented
last_updated: "2026-09-17"
---

# Durable dynamic tool schemas

Dynamic tools must run their authored validators. JSON Schema cannot retain
transforms or refinements, and an in-memory validator cache cannot preserve
captured state across recovery. Related: #1682.

## Authoring contract

Keep `inputSchema` and `outputSchema` expressions in `defineTool()`. The compiler
hoists each expression into a schema factory and snapshots its referenced local
JSON values using the existing durable callback mechanism. Stable module-level
schema references are supported; local schema objects, clients, and functions
are non-serializable captures and fail resolution with a diagnostic.

Packages outside the source transform use `defineDurableSchema({ closure,
schema })` from `eve/tools`. The synchronous `schema` function receives the JSON
closure snapshot and returns the authored schema. The helper preserves Standard
Schema validation and JSON Schema emission. Plain JSON schemas remain supported.

Factories must be deterministic for their captures. Read changing external data
in the resolver and capture its JSON result. Module-level values and imports are
live code under the same contract as existing durable callbacks.

## Replay

Store schema factories as input/output phases in the existing callback registry.
Persist their closure data alongside execute/approval closures and the model's
JSON Schema description. Materialize a validator from the persisted closure
when validation is first needed. Preserve async validation and Zod 3 input
validation. Missing factories fail closed at validation.

Session recovery re-runs the owning resolver to register its current code but
keeps the original factory and executor captures. Existing scope and redeploy
rules apply. There is no independent validator registry or per-schema eviction.

Memory provider tools rebuild schemas with the same persisted provider context
used to reconstruct their callbacks. Existing extensions must be rebuilt to
include the new schema descriptors. The runtime rejects unstamped live schemas
rather than silently reducing them to JSON validation.

## Verification

Unit coverage checks captures, cross-session isolation, all lifecycle scopes,
missing descriptors, async validation, and large tool sets. A process-restart
scenario changes resolver configuration while an approval is parked and checks
that a non-idempotent transform and executor both retain their original capture.
Fixture evals exercise transformed dynamic input across turns in CI.

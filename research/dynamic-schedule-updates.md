---
issue: "TBD (maintainer-requested implementation; no matching issue found)"
status: implemented
last_updated: "2026-10-08"
---

# Dynamic schedule updates

Add `update(name, { expression?, payload? })` to authenticated dynamic schedule
clients and generated operation tools. Require at least one field and reject
unsupported fields. Timing uses the creation input, including relative delays.
Payload is complete replacement input, not a deep or partial merge.

## Ownership and preparation

Authorize each update through `scope` with operation `"update"`, and require an
existing schedule in that namespace. Timing-only updates preserve the stored
payload and creator. Payload updates validate `inputSchema`, run `preparePayload`
with trusted updater context, and capture the updater's principal and resolved
scope in a new envelope. Future execution re-resolves that principal through
`auth`. Shared-scope management access never grants the old creator's identity.

`preparePayload` receives `operation: "create" | "update"`. Generated create and
update tools share bounded, durable approval snapshots. `approval.update`
receives the prepared payload, or `undefined` for timing-only updates. Prepare
again at execution and reject changed snapshots before writing. Authenticated
code prepares once without model approval.

## Provider boundary

Add a required provider `update` method accepting optional absolute timing and
payload. The Vercel provider uses the SDK's PATCH operation, wrapping replacement
payloads in the existing dispatch envelope. No payload readback or separate
metadata store is needed. In-memory updates preserve identity and state and use
the existing operation-result replay mechanism.

Do not expose target, name, namespace, or state patches. State changes retain
`enable`/`disable`. Updates affect future work, not already started occurrences;
concurrent writes have no compare-and-swap guarantee. Management remains blocked
during scheduled execution, and public reads still omit payload and creator data.

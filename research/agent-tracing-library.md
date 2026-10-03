---
issue: TBD
status: proposed
last_updated: "2026-10-03"
---

# Durable agent tracing

Extract only the durable span lifecycle consumed by eve. Keep SDK setup,
serialization, request/MCP tracing, remote trust, and storage in eve.
Do not add a simple-agent API until a second production consumer exists.

The [module README](../packages/eve/src/tracing/lib/README.md) defines ownership,
operation handles, opaque snapshots, capture, and replay behavior.

Keep the library and eve migration in separate PRs. Measure library source,
net production code, and net total diff in both PR descriptions. Preserve
schema version 4 and existing topology; live ingestion remains a platform check.

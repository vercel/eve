---
issue: https://github.com/vercel/eve/pull/3338
status: in-progress
last_updated: "2026-09-14"
---

# Activation metadata contract

## Summary

Schema v4 activation roots need a small provider-neutral attribute set for
filtering and grouping without inspecting captured payloads. The contract keeps
structural metadata on `invoke_agent` spans while preserving eve's existing
trace-content and destination-redaction boundaries.

## Attribute ownership

Every activation carries its run type, agent identity, channel kind and
audience, turn identity, and directional content-policy results. Root-session
activations additionally carry their origin, authored schedule ID when
applicable, and bounded initial title when input capture permits. Subagent
activations omit those root-only attributes and use parent lineage to describe
delegation.

The session title is derived once from the initial session input, stored in the
run context, and repeated on each turn activation. It never describes a later
turn. Titles remain input content and can be omitted by the trace decision or
removed by a destination's input-redaction policy.

## Sampling and export invariants

Session metadata is available before the first turn is sampled. A sampler and
the resulting exported activation therefore observe the same channel kind,
schedule provenance, and title.

The `agent.trace.content.input` and `agent.trace.content.output` attributes
describe what the receiving destination can observe. Destination redaction can
narrow either value from `true` to `false`; it cannot widen the session's
resolved trace decision.

## Scope

This contract does not change workflow lifecycle ownership, status semantics,
trace identity, or remote-lineage authorization. It only makes existing
activation metadata queryable across OpenTelemetry destinations.

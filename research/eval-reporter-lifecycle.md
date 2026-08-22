---
issue: https://github.com/vercel/eve/issues/1979
status: implemented
last_updated: "2026-08-12"
---

# Eval reporter lifecycle and trace correlation

## Summary

Eval reporters need a live boundary before each case runs and an authoritative way to correlate the
agent work with an observability backend. A single eval can create several sessions, and a long
session can span several traces, so the contract does not pretend that an eval owns one trace.

```text
onRunStart
  +-- onEvalStart
        +-- onSessionStart     (first traced event in each session)
        +-- onEvalComplete     (all observed session traces)
  +-- onRunComplete
```

## Public contract

`EvalReporter` adds two optional callbacks:

- `onEvalStart` fires when the runner schedules an observed eval. No session or trace exists yet.
- `onSessionStart` fires once for each session after its first trace-bearing stream event. It
  includes the session id, whether the session is primary, and eve-owned W3C trace coordinates.

`onEvalComplete` keeps the existing result argument and receives additional context containing the
evaluation, target, and every distinct trace observed across its sessions. The same trace contexts
are retained on task/session results, JSON artifacts, and Braintrust metadata.

Tracing is optional at the target boundary. `onEvalStart` and `onEvalComplete` always fire, while
`onSessionStart` only fires when the target emits trace context. Reporters must therefore treat
an empty completed trace list as a supported uninstrumented run.

## Runtime boundary

The server attaches an eve-owned `RuntimeTraceContext` to `session.started` and `turn.started`.
Authored OpenTelemetry uses the turn span context. Zero-config local tracing prepares its session
window and turn state before durable event emission, then reuses that prepared state when native
lifecycle hooks observe the event. Preparation is idempotent and failure-isolated so tracing cannot
change agent execution.

The eval session driver deduplicates contexts by trace and span id in stream order. It delivers the
first context live and retains later turn/window contexts for completion and artifacts.

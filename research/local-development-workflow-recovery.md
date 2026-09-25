---
issue: "TBD (maintainer-requested follow-up to https://github.com/vercel/eve/pull/3816)"
status: implemented
last_updated: "2026-09-25"
---

# Explicit local workflow recovery

## CLI and semantics

- `eve dev` starts fresh execution. Retained unfinished runs from previous server invocations remain stored but dormant.
- `eve dev --resume` attempts recovery of all retained, compatible unfinished local runs. It does not reopen a TUI conversation.
- Exit preserves unfinished state. Missing snapshots still cause cancellation through the orphan-cleanup policy; incompatible snapshots remain stored without execution.
- Recovery requires the same framework fingerprint and authored workflow-source fingerprint. Legacy snapshots without compatibility metadata are not eligible.
- The flag rejects URL targets, an already-running local server, and custom Workflow Worlds. Custom Worlds retain their own recovery semantics.

## Lifecycle boundary

```text
CLI invocation → server host / local World → worker A → worker B
                       │                    watcher replacement
                       └─ admitted generation IDs survive replacement
new CLI invocation → new host / new admission set
```

The host admits its active generations and, with `--resume`, compatible retained generations. Both workflow and step deliveries check host admission and compatibility before executing, including first deliveries carrying resilient-start input. Skipping startup enqueue alone is insufficient because hooks and timers can enqueue old runs later.

Snapshot retention remains bounded. This feature does not preserve old executable hosts: changing authored workflow bodies can invalidate old runs even within one invocation. Ordinary runtime-source changes and worker replacement do not reset admission.

## Validation boundary

Transport tests cover startup recovery, dormant workflow/step/resilient-start deliveries, later opt-in recovery, and generation promotion. CLI and subprocess-option tests cover flag propagation. Existing real-server scenarios cover an in-flight workflow surviving generation promotion and worker failure, and continued conversations using newly added tools. A full-process conversation restart probe encountered the existing shutdown limitation: an in-flight RPC to the old port can fail and terminally fail the owner run. `--resume` does not resurrect terminal runs; the existing restart scenario remains skipped pending upstream abortable queue delivery support (https://github.com/vercel/workflow/pull/3824).

---
issue: https://github.com/vercel/eve/issues/3201
status: implemented
last_updated: "2026-09-22"
---

# Sandbox access in workflow steps

Authored workflow steps access the session sandbox lazily through `ctx.getSandbox()`; the session retains initialization and lifecycle ownership.

Approval ordering remains tracked separately in [#3198](https://github.com/vercel/eve/issues/3198); this change does not fix it.

## Authoring contract

Use `defineWorkflowTool({ execute })` and pass `ctx` directly to a `"use step"` helper typed as `WorkflowStepToolContext`. Both blocking and background workflows support this contract. The workflow body remains deterministic and cannot open a sandbox.

## Boundaries

- A workflow that never calls `getSandbox` does not open a sandbox.
- On first access in each step, the step requests initialization through its owner inbox. The owning session checks the recorded run, opens or reconnects its sandbox, and persists the updated session checkpoint before returning a serializable reconnect record. Blocking and background requests use the same internal session handler; background tasks forward through the stable parent inbox.
- A durable response stream keyed by the requesting step lets retries reuse the response. Concurrent steps are initialized through the owning session so they share its initialization state. This adds an owner round trip on first access in each step.
- Each workflow step binds a lazy `SandboxAccess` under `SandboxKey` and uses the existing tool getter and cancellation wrapper. Calls in one step share access; later steps reconstruct it from the session's saved state.
- Steps cannot stop or delete the shared sandbox. They consume or kill spawned processes before returning and return serializable results, never live handles or streams.
- After the sandbox provider redesign in #3271, steps resume immutable provider session state. Missing native state and provider resume failures propagate; this change adds no new persistence guarantees.

## Validation

Runtime integration coverage checks regular tools and workflow steps reading and updating the same sandbox. It also covers durable waits, concurrent first accesses, step retries, and rejected access from the workflow body for blocking and background tools. Fixture evals exercise the same contract through an agent. CI is required for the fixture evals.

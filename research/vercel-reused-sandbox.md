---
issue: TBD
status: draft
last_updated: "2026-09-15"
---

# Experimental reused Vercel Sandbox

## Goal

Allow trusted eve sessions to reuse one native Vercel Sandbox without restoring a framework-level sandbox naming or sharing API.

```ts
export const environment = ExperimentalVercelReusedDockerfile.environment({
  key: "trusted-team-workspace",
  networkPolicy: "deny-all",
  region: "iad1",
  resources: { vcpus: 4 },
});

export default defineSandbox(() => environment.open());
```

## Semantics

- `key` is immutable environment configuration, not an `open()` option.
- `open()` takes no options and returns the current eve session's logical sandbox view.
- The provider derives the native identity from `key` and the prepared image/resource generation.
- Sessions with the same derived identity use one persistent filesystem and network boundary.
- Per-session eve tags are not written to the reused native Sandbox.
- Logical `stop()`, `shutdown()`, and `delete()` do not tear down reused compute.
- `setNetworkPolicy()` changes the native policy for every attached session.
- Changing the Dockerfile, managed resources, or environment configuration rotates the native identity.

## Trust boundary

This provider is for mutually trusted sessions. A logical session ID or workspace path does not isolate native processes, files, credentials, ports, or network policy. Untrusted tenants require separate native sandboxes.

## Architecture

The provider is separate from `ExperimentalVercelDockerfile` and implements the existing `defineSandboxProvider()` contract. Core remains session-owned and has no reuse key, native name, scope, or shared-lifetime branch.

The first `open()` creates persistent compute from the exact prepared image and Drive artifacts. Later calls locate that compute by its provider-derived identity. Every call adapts the same native Sandbox into a `RuntimeSandboxSession` whose public ID is the current eve session sandbox identity.

## Spike limitations

The spike does not add native compute garbage collection, leases, attachment accounting, concurrency control, or an administrative delete operation. Those lifecycle policies must be designed before this surface can graduate.

---
issue: TBD
status: draft
last_updated: "2026-09-16"
---

# Experimental reused Vercel Sandbox

`ExperimentalVercelReusedDockerfile` is a distinct provider layered on the Vercel Dockerfile image provider:

```ts
export const environment = ExperimentalVercelReusedDockerfile.environment({
  networkPolicy: "deny-all",
  region: "iad1",
  resources: { vcpus: 4 },
});

export default defineSandbox(() => environment.open());
```

The provider derives native identity from the validated image/Drive artifact, immutable environment options, and its provider contract version. It excludes the eve session ID, so sessions using the same environment generation converge on one persistent native Vercel Sandbox.

Core still owns one logical handle and immutable serialized provider state per eve session. Durable boundaries bypass `defineSandbox()` and call the provider's `resume()` directly with the current artifact and state. The provider validates the shared native identity, reconnects existing compute, and fails if that compute is gone. Its exact session type omits mutable `setNetworkPolicy()`, and session stop, runtime shutdown, and session deletion detach logically rather than tearing down native compute.

This provider is for mutually trusted sessions. They share processes, files, ports, credentials, and one immutable network boundary. Concurrent creation, initialization recovery, attachment accounting, and garbage collection remain provider implementation details for this experiment.

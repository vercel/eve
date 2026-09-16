---
issue: TBD
status: draft
last_updated: "2026-09-15"
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

Core still owns one logical handle and minimal serialized provider state per eve session. The provider validates that state during `resume()`. It omits mutable `setNetworkPolicy()` and maps session stop, runtime shutdown, and session deletion to logical detachment rather than native teardown.

This provider is for mutually trusted sessions. They share processes, files, ports, credentials, and one immutable network boundary. Concurrent creation, initialization recovery, attachment accounting, and garbage collection remain provider implementation details for this experiment.

---
"eve": patch
---

Handle missing sandbox template and session state more gracefully across Vercel, Microsandbox, and Docker backends. Eve now treats stale Vercel template references, missing Microsandbox session/template snapshots, and Docker template image races as recoverable provisioning misses so the runtime can rebuild or create a fresh sandbox automatically.

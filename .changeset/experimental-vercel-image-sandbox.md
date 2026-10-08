---
"eve": patch
---

Add an experimental Vercel image environment that defaults to eve's base image and publishes a digest-pinned OCI image when a Dockerfile is present. Managed workspace and skill resources start from content-addressed Drives and use writable per-session forks that are deleted when the session ends.

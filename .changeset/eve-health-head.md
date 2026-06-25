---
"eve": patch
---

eve's health endpoint (`/eve/v1/health`) now responds to `HEAD` requests, not just `GET`, so load balancers and uptime monitors that probe with `HEAD` (UptimeRobot, Kubernetes probes, and others) no longer report a healthy deployment as down.

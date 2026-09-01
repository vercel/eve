---
"eve": minor
---

Reduce channel turn latency by using optimized session resumes, routing work to the deployment that accepted it, and running ordinary same-deployment turns without a child-workflow handshake. Turns that need sleep, background work, runtime actions, or cross-deployment execution continue in the existing child workflow without repeating completed steps.

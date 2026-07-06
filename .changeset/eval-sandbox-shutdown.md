---
"eve": patch
---

`eve eval` now shuts down tracked sandbox handles after a local one-shot eval run completes. This prevents local sandbox compute, including microsandbox sessions, from outliving the eval process.

---
"eve": patch
---

Classify proactive Slack sends, including static and dynamic schedules, so trace policies can capture public-channel inputs and outputs; failed lookups remain unknown. Generated Slack app manifests now request `channels:read`; existing apps must grant that scope and reinstall to enable lookups.

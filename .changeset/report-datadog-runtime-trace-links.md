---
"eve": patch
---

Datadog Experiment reports now link each eval to its sampled runtime traces using Datadog-indexed IDs. Linked traces include classified structural spans and, when capture is enabled, turn-level task input and output; zero-duration Experiment spans are normalized to a positive duration. Canonical runtime spans remain unchanged.

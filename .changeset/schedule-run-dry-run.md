---
"eve": minor
---

Add `eve send <message>` and `eve schedule run <name>` to send one message or fire one schedule from the CLI, with `--dry-run` to preview the turn without calling a model: the tools each caller gets, why each hidden tool is hidden, and, for schedules, the deliveries and `fetch` calls recorded instead of sent.

`eve schedule run <name> --dry-run` also previews a dynamic schedule's occurrence with `--payload` and `--as <creator>`.

---
"eve": patch
---

New `eve logs` command for reading the diagnostic logs `eve dev` writes under `.eve/logs/`: `eve logs` prints the most recent log, `eve logs ls [--json]` lists them, and `eve logs <logid>` prints a specific log by id, file name, transcript path, or unambiguous prefix.

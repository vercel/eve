---
"eve": patch
---

`localDev()` now refuses callers on other machines. Before, an `eve dev` server started with `--host 0.0.0.0` gave every LAN caller the `local-dev` principal, so they could run the agent and its local editing tools, which write to the project's `agent/` source. Callers on the same machine are unchanged, including the developer's own clients when `--host` names a LAN address.

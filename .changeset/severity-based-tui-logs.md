---
"eve": minor
---

The TUI's `--logs` and `/loglevel` modes are now `none`, `error` (default), `warn`, `debug`, and `all`, replacing the `stderr` and `sandbox` filters. Console warnings retain their severity across local server workers, stay hidden by default, and render yellow when enabled; unclassified output is shown only with `all`, in neutral styling.

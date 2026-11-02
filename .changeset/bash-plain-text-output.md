---
"eve": patch
---

The provided `bash` tool shows the model its output as plain text instead of JSON, so source code, diffs, and test logs reach the model without escaped newlines and quotes.

The model reads stdout, then any stderr after a `stderr:` line, then `exit code: N`; a command still running ends with its instructions instead. The tool's `execute` output, its output schema, and `call.settled` events keep the structured fields. Wrappers that spread `bash` keep the plain-text view; if a wrapper's `execute` returns another shape, the model sees it as JSON.

---
"eve": minor
---

`bash` results match pi: a successful command shows only its output, or `(no output)`, and a command that exits non-zero ends with `[exit code: N]` and reaches the model as an error result.

`toolOutput.errorText(value)` from `eve/tools`, or a `{ type: "error-text", value }` literal, lets any tool's `toModelOutput` show the model a failure while the call still completes, so channels and hooks get the full output on `call.settled`.

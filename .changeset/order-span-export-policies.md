---
"eve": minor
---

Make managed destination `exportPolicy` accept one policy or an ordered policy array, with explicit span `emit` and redaction decisions. Attribute policies now return `emit` or `replace` decisions; and the deprecated `redactSpanInputs()`, `redactSpanOutputs()`, destination `recordInputs`, destination `recordOutputs`, `content`, and `composeSpanExportPolicies()` APIs are removed.

Use these replacements:

| Before                            | After                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------- |
| `span: () => false`               | `span: () => ({ emit: false })`                                                 |
| `redactSpanInputs(when)`          | `span: (span) => when(span) ? { redact: true, inputs: true } : { emit: true }`  |
| `redactSpanOutputs(when)`         | `span: (span) => when(span) ? { redact: true, outputs: true } : { emit: true }` |
| `recordInputs: false`             | `exportPolicy: { span: () => ({ redact: true, inputs: true }) }`                |
| `recordOutputs: false`            | `exportPolicy: { span: () => ({ redact: true, outputs: true }) }`               |
| `{ action: "keep" }`              | `{ emit: true }`                                                                |
| `{ action: "drop" }`              | `{ emit: false }`                                                               |
| `{ action: "replace", value }`    | `{ replace: true, value }`                                                      |
| `composeSpanExportPolicies(a, b)` | `exportPolicy: [a, b]`                                                          |

Passing the removed destination `recordInputs` or `recordOutputs` options now
throws during declaration instead of silently exporting content.

Returning a boolean from `span` still works but is deprecated; return
`{ emit: boolean }`.

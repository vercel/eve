---
"eve": minor
---

Add `experimental.codeMode` to the agent config and replace the experimental `Workflow` model tool with one synchronous `code_mode` orchestration option. Setting it to `true` keeps ordinary tools directly callable and also exposes typed inline tools to generated TypeScript through a capped progressive catalog with in-program search. The same structural admission rule applies to request-visible dynamic tools. The AI SDK code-mode executor runs the program in isolated QuickJS and returns its JSON result as an ordinary tool result. Approval-gated tools, subagents, background tools, provider-managed tools, and control-plane tools remain direct only. `experimental_workflow()` and the separate `Workflow` tool are removed.

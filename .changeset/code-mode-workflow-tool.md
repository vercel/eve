---
"eve": minor
---

Replace the experimental `Workflow` tool and `eve/tools/workflow` helper with `experimental.codeMode: { mode: "eager" | "lazy", maxSubagents?: number }`: programs discover all available tools, call eligible tools, await subagents, and enforce a subagent-call budget (100 by default). Nested calls resume durably after authorization and expose catchable failures; approval-gated tools and ordinary background tools remain direct. Eager keeps eligible direct tools available and guides the model toward programs for dependent calls and data processing; lazy exposes eligible tools through discovery.

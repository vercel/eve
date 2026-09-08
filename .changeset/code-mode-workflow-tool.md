---
"eve": minor
---

Replace the experimental `Workflow` tool and the `eve/tools/workflow` helper with `experimental.codeMode: {} | { maxSubagents?: number }`. The framework `code_mode` tool runs a model-written JavaScript program as a durable workflow: eligible tools are exposed only through the program, discovered on demand with `tools.search_tools` and `tools.describe_tools`, and each nested tool or subagent call runs as its own step that resumes after authorization. Approval-gated tools, authored workflow tools, background tools, and framework controls stay directly callable; subagent calls are capped per program (100 by default). Program errors return to the model without retrying the unchanged source.

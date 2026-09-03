---
"eve": patch
---

Add `experimental.codeMode` (`"eager"` or `"lazy"`) to the agent config. Eligible tools move behind one framework `code_mode` tool that runs the model's JavaScript program as a durable workflow: each nested tool call gets its own step and replay boundary, and subagent calls inside the program go through the same owner channel as any workflow tool, so a program can launch and await subagents.

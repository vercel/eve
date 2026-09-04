---
"eve": patch
---

Add `experimental.codeMode` (`"eager"` or `"lazy"`) to run JavaScript programs that discover every available tool, call eligible static and dynamic tools, await subagents, and catch individual call failures. Each nested call has its own durable boundary and can wait for authorization; approval-gated tools and ordinary background tools stay available as direct calls.

---
"@vercel/agent-runs": patch
"eve": patch
---

Record the end user as `vercel.user_id` on activation, step, and model spans, AI Gateway cost and generation ID on the `chat` span under OTel GenAI names, and reasoning tokens as `gen_ai.usage.reasoning.output_tokens`.

---
"eve": patch
---

Add `experimental.useCodexSubscription` to agent config: in development, OpenAI string models (`model: "openai/gpt-5.5"`) authenticate through your local Codex login (`~/.codex/auth.json`) instead of AI Gateway credentials. Production builds ignore the flag and keep the model on its normal AI Gateway route.

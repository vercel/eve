---
"eve": patch
---

Agent-messaging `<agents>` listings are now announced as framework-injected user-role notes instead of assistant messages appended to history. This fixes parent resume failures on models that reject assistant-final requests (e.g. `This model does not support assistant message prefill` from Claude via AI Gateway) after a persistent child parks, keeps the announcement append-only so provider prompt caches stay warm, and the agent-messaging system prompt now declares the `[Agents]` note as framework-injected.

---
"eve": minor
---

Replace Slack's per-action `onInteraction` contract with payload-level `onBlockActions` for message, App Home, and modal controls, plus a raw `onInteraction` fallback for other interactive callbacks. Message-backed callbacks expose thread and session operations under `ctx.message`.

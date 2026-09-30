---
"eve": patch
---

The self-modification subagent no longer tries to install `eve/self-modification` when asked to change the agent's own instructions. To change the subagent's own model or reasoning, it now creates or edits `agent/extensions/self-modification/extension.ts` directly.

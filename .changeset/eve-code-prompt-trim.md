---
"eve": patch
---

The code extension (`eve/extensions/code`) sends a much shorter prompt that keeps only coding and safety rules, so agents spend fewer tokens on every step.

The prompt no longer assumes a chat product or sets consumer policy, such as brevity, asking one question, avoiding em dashes, omitting private references, or not rebasing. Agents that relied on those rules should state them in their own `agent/instructions.md`. Agents publish or write to external systems only when the requester asks for it or for an outcome that requires it, such as a pull request. The prompt asks agents to edit files with the editing tool instead of the shell, and no longer names `apply_patch` specifically. The issue and design checklists moved into the `code__investigate` skill.

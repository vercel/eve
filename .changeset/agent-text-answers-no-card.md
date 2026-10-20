---
"eve": patch
---

A parent agent's message to a subagent no longer answers the subagent's pending tool approval or session-limit prompt. Before, a follow-up such as `approve` or `continue` sent to a held subagent settled the card as if the person had answered it. These prompts now settle only on a structured answer from the person. The parent's message is still delivered to the subagent as an ordinary message.

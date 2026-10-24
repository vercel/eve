---
"eve": patch
---

A parent agent's message to a subagent no longer answers the subagent's pending tool approval or session-limit prompt. Before, a follow-up such as `approve` or `continue` settled the prompt as if the person had answered it. Now only a person's structured answer settles it: the parent's message is delivered as an ordinary message, so a pending approval resolves as `ignored` and a session-limit prompt keeps waiting for the person. Thanks @devon-seitz for reporting this in #5075.

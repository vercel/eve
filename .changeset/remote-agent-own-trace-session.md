---
"eve": patch
---

On Vercel, a remote agent's spans now carry its own session ID as `vercel.session_id` instead of the calling deployment's root session, and its local subagents carry the same ID. Agent Runs in the receiving project lists the remote agent as its own session, with its turns, subagents, and token usage. `gen_ai.conversation.id` still names the caller's conversation.

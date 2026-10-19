---
"eve": patch
---

The Photon and Linq channels can now pass tapbacks to the agent with a new `onTapback` hook, which can also answer the approval or question posted in the message the tapback is on, for example approving with a like. `channel.tapbackTool()` gives the model a tool that reacts to the latest message with a standard tapback or any emoji. Tapbacks stay ignored unless you opt in.

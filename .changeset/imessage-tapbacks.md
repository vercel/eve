---
"eve": patch
---

The Photon and Linq channels can now pass tapbacks to the agent with a new `onTapback` hook, and `channel.tapbackTool()` gives the model a tool that reacts to the latest message with a tapback. Tapbacks stay ignored unless you opt in.

---
"eve": minor
---

Slack renderers can handle `call.input` to show a tool call's arguments while the model is still writing them.

This lets a renderer post a draft of what a call will produce, such as a card, and edit it as the arguments stream in. eve's default rendering ignores `call.input`, so existing channels behave the same.

---
"eve": minor
---

Show a Slack code channel's context bar and diff view.

`setCodeChannelContextBar()` and `setCodeChannelDiffView()` from `eve/channels/slack` set a code channel's context bar and diff view from a renderer or channel event handler. They call Slack only when what the channel shows changes, cut a diff over Slack's size limit at a file boundary, and do nothing outside code channels.

`codeChannelSurfaces()` from `eve/extensions/code/slack` is a Slack renderer for coding agents: after each tool call that can change the workspace, it shows the repository, branch, changed files, and pull request in the context bar and every change against the base branch in the diff view.

---
"eve": patch
---

Discord and Teams now pass files people send to the agent. Discord reads files from slash-command attachment options, and guided setup registers an optional `file` option. Teams accepts files by default from Bot Connector and SharePoint hosts; set `files: { enabled: false }` to opt out, and `allowedHosts` now adds hosts instead of replacing them.

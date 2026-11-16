---
"eve": patch
---

A `gh` or `git` command that holds the sandbox's GitHub credential lock for more than 5 minutes is now stopped with a `GitHubCommandTimeoutError`, and a lock whose command stopped is taken over after 6 minutes instead of 10. Before, one hung command blocked every other GitHub command in the sandbox for 10 minutes. Cancelling a tool call now also stops its running GitHub command.

---
"eve": minor
---

Computer use moves out of `eve/extensions/code` into its own built-in extension, `eve/computer-use`. Mounting the code extension no longer adds `computer_use`, so agents without a desktop stop sending its schema on every request. Agents that use computer use should mount `eve/computer-use` next to the code extension; mounted as `agent/extensions/computer-use.ts`, the tool is named `computer-use__computer_use`.

The sandbox helpers are now exported from `eve/computer-use/sandbox` and the tool from `eve/computer-use/tools`. The old `eve/extensions/code/sandbox` and `eve/extensions/code/tools` exports still work but are deprecated.

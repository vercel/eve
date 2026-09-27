---
"eve": minor
---

Computer use moves out of `eve/extensions/code` into its own built-in extension, `eve/extensions/cua`. Mounting the code extension no longer adds `computer_use`, so agents without a desktop stop sending its schema on every request. Agents that use computer use should mount `eve/extensions/cua` next to the code extension; the tool is then named `cua__computer_use`.

The sandbox helpers are now exported from `eve/extensions/cua/sandbox` and the tool from `eve/extensions/cua/tools`. The old `eve/extensions/code/sandbox` and `eve/extensions/code/tools` exports still work but are deprecated.

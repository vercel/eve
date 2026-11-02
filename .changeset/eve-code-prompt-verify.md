---
"eve": patch
---

The code extension (`eve/extensions/code`) now has agents check each requirement and edge case of a request by running code before they finish a change, and report the files they changed and the checks they ran.

The prompt also tells agents not to weaken or delete existing tests to make them pass, to say which reading they chose for an ambiguous request, and to remove scratch files they created for checking.

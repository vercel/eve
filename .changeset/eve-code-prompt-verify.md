---
"eve": patch
---

The code extension (`eve/extensions/code`) now has agents check each requirement and edge case by running code before they finish a change.

Agents also run broader checks in proportion to what the change touches, change a test only when the request changes the behavior it asserts, say which reading they chose for an ambiguous request, remove scratch files they created only for checking, and name the files they changed, the checks they ran, and what they could not check.

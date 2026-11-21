---
"eve": patch
---

Fix `computer_use` scrolling, which always failed because the desktop driver didn't get the pointer position, accept key names such as `Page_Down`, `page_down`, and `ArrowDown`, and wait up to 30 seconds for the desktop to start in a new sandbox.

The fix also exports `COMPUTER_USE_REVALIDATION_KEY` from `eve/extensions/computer-use/sandbox`, as its README documents, and changes it, so prepared sandbox templates that include it rebuild with the fixed driver.

---
"eve": patch
---

Fix `computer_use` scrolling, which always failed because the desktop driver didn't get the pointer position, and accept key names such as `Page_Down`, `page_down`, and `ArrowDown`.

The fix also exports `COMPUTER_USE_REVALIDATION_KEY` from `eve/extensions/computer-use/sandbox`, as its README documents, and changes it, so prepared sandbox templates that include it rebuild with the fixed driver.

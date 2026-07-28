---
"eve": patch
---

Session token limits are now tracked as a runtime limit — an absolute lifetime-usage ceiling that each approved continuation re-anchors to `usage + configured limit` — replacing the window-baseline bookkeeping. Behavior is unchanged except the continuation prompt's `usedTokens` now reports the absolute session total instead of the window-relative amount.

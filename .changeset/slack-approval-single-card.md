---
"eve": patch
---

Slack tool approvals now render as one card that holds the prompt, the tool input, and the **Approve** and **Deny** buttons.

The card replaces the separate approval card and collapsed **Tool input** block. It lists the input one field per line within a fixed size budget, so a click's callback stays bounded however large the input is. Approvals without input keep the compact card.

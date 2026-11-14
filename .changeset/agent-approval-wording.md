---
"eve": minor
---

Approval cards can now be localized once for the whole agent: `defineAgent`'s `approval` accepts an object with `prompt` and `labels`, and a tool's `approval` accepts `labels` to rename its **Approve** and **Deny** buttons.

The agent-wide policy moves to `request` in the object form; the function form is unchanged. A tool's own `prompt` and `labels` still win, the option ids stay `approve` and `deny`, and approval `prompt` callbacks now receive `toolLabel`, the label in the default `Approve <tool label>?` text. Slack and ACP clients now show the request's option labels instead of fixed English text.

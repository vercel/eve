---
"eve": patch
---

Post a Slack reply as plain Markdown when Slack fails its Block Kit blocks with `fatal_error`, instead of dropping the reply. Slack says a `fatal_error` call may have partly succeeded, so in rare cases the reply can appear twice.

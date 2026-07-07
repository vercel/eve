---
"eve": patch
---

Slack channel replies whose plain text or Markdown exceed Slack's `chat.postMessage` field limit (40,000 characters for plain `text`, 12,000 for the native `markdown_text` field) are now split into multiple ordered thread messages instead of failing with `msg_too_long`. Splitting prefers paragraph, line, then word boundaries. Set `chunkMessages: false` on the channel to keep the previous single-post behavior; structured (`blocks`/`card`) and file posts are unaffected.

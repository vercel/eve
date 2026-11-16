---
"eve": minor
---

Slack replies can stream into the thread as the model writes them with `slackChannel({ experimental: { streaming: true } })`, using Slack's native `chat.startStream`, `chat.appendStream`, and `chat.stopStream`.

Replies start streaming once they pass 280 characters, and the completed reply still runs through renderers: delivering it closes the streamed message, or rewrites it when a renderer changed the text. What streams is the text that reaches eve's default `content.delta`, so a renderer that changes replies at `content.completed` must also handle `content.delta` before replies stream. Streaming needs only the `chat:write` scope and falls back to posting the reply whole when Slack can't stream.

---
"eve": patch
---

Add `experimental_chatgpt` under the new `eve/models/openai` subpath: it returns an AI SDK language model served through the local Codex login (`codex login`), billed to the ChatGPT subscription, and defaults to `gpt-5.6-sol`. Direct provider API request errors now also surface their upstream message when one is available.

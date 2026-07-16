---
"eve": patch
---

Send a versioned `User-Agent` on AI Gateway model calls. eve now sets a leading
`eve/<version> (<agent name>)` product token, and the AI SDK appends its own
`ai/<version> ai-sdk/provider-utils/<version> runtime/node.js/<version>` tokens
after it, so gateway traffic is attributable to both the eve and SDK versions
alongside the existing `x-title` and `http-referer` attribution headers.

---
"eve": patch
---

With `otel({ traceChannelRequests: true })`, the `agent.channel.request` span now ends when the response body finishes, fails, or is cancelled, not when the route handler returns. Session stream requests no longer log `You can only call end() on a span once.` for `workflow.stream.read.connect`, and request spans now cover the full streaming time. Thanks @ahcarpenter for reporting this and proposing the fix in #4256.

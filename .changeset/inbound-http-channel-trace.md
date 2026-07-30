---
"eve": patch
---

Emit one OpenTelemetry `SERVER` span for every inbound HTTP channel request. The span is named for the registered route (e.g. `POST /eve/v1/session/:sessionId`), respects an incoming `traceparent` (becoming a child of the upstream span, or a trace root when there is none), and becomes the parent of nested channel and Workflow spans such as `hook.resume` and outgoing HTTP calls. It records only low-cardinality, non-sensitive attributes (`http.request.method`, `http.route` — the path template alone, per the OTel HTTP convention — `http.response.status_code`, `url.scheme`, `server.address`, `eve.channel.name`, `eve.channel.kind`) — never session ids, tokens, headers, bodies, or query parameters. This is observability-only: it does not change request handling and performs no synchronous span export in the request path, adding only minimal in-process tracing overhead.

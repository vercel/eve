---
"eve": minor
---

Upgrade Nitro and preserve encoded slashes and backslashes in channel parameters; handlers that require decoded separators must now decode and validate them explicitly. GET channels now handle HEAD requests automatically, and custom WebSocket channels gain subprotocol selection, buffer and drain controls, and ping/pong hooks on supported hosts.

---
"eve": patch
---

MCP connections now ask the user to sign in only when the server asks for it. When a connection has `auth` but no token yet, eve connects without an `Authorization` header, so servers that allow anonymous `initialize` and `tools/list` have their tools listed by `connection_search` and run by `connection_execute` with no prompt. Sign-in starts when a call returns HTTP `401` or an error result with a `_meta["mcp/www_authenticate"]` challenge, and the call runs again with the token once the user signs in. Servers that reject every request without a token behave as before, and connections that already have a token are unchanged.

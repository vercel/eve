---
"eve": patch
---

Resolve MCP credentials before each request so live clients use refreshed tokens after expiry. Retry a rejected bearer once through the token provider before requesting sign-in, while preserving existing permission errors.

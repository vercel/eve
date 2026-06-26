---
"eve": minor
---

Add a searchable `/connect` flow to the local dev TUI. It scaffolds an MCP connection, resolves its Vercel Connect connector, and reuses the model setup flow to create or link a Vercel project when needed. Local Vercel users now authorize Connect with their Vercel user ID instead of a reserved OIDC issuer.

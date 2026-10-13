---
"eve": patch
---

Connections that share a host, such as Jira and Confluence on one Atlassian domain, no longer trigger the "could not assign a unique toolResultFrom identity" warning, and `toolResultFrom` now accepts OpenAPI connections, including ones without a `baseUrl`.

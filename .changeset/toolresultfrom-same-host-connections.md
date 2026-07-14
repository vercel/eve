---
"eve": patch
---

`toolResultFrom` now narrows results from OpenAPI connections and gives connections on the same host distinct identities, so two `defineOpenAPIConnection` definitions sharing a `baseUrl` (e.g. Jira and Confluence on one Atlassian domain) each match through their imported definition object instead of colliding on a shared `connection:<host>` identity.

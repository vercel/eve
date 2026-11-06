---
"eve": patch
---

New Web Chat sign-in setups authenticate with the project's Vercel OIDC identity instead of an OAuth client secret.

Existing client-secret setups and session secrets are preserved when setup resumes.

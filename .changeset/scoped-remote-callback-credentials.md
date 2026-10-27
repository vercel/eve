---
"eve": minor
---

Protected cross-project callbacks now require reciprocal Vercel Trusted Sources and an explicit `EVE_CALLBACK_TRUSTED_ORIGINS` allowlist on the remote deployment. Callback URLs no longer include the parent's deployment-wide bypass secret; listed origins instead receive the remote's short-lived OIDC credential.

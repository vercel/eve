---
"eve": patch
---

Stop including deployment-protection bypass secrets in remote callback URLs. Protected Vercel parents can admit callbacks through Trusted Sources, with remote OIDC credentials restricted to exact origins configured in `EVE_CALLBACK_TRUSTED_ORIGINS`.

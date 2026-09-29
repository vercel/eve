---
"eve": patch
---

Connection sign-in callback URLs no longer include `VERCEL_AUTOMATION_BYPASS_SECRET`, so the secret stays out of the links shown to users and the `redirect_uri` sent to providers. On a deployment behind Deployment Protection, the person signing in now passes protection on their own, for example through Vercel Authentication or a Deployment Protection Exception.

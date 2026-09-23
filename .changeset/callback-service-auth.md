---
"eve": patch
---

Remote child agents now authenticate completion, progress, and activity callbacks with their own identity: on Vercel the deployment's OIDC token is sent to every HTTPS callback URL, and `eveChannel({ callbackAuth })` supplies the credential elsewhere. In return, `POST /eve/v1/session` and session-message bodies carrying `callback` or `activityObserver` are only accepted from callers the channel's `trustedForwarders` predicate trusts; without a predicate or for an untrusted caller they are rejected with 403 (local `eve dev` exempt).

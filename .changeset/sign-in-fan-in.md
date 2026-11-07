---
"eve": patch
---

One answer now settles every parallel subagent waiting on the same Vercel Connect sign-in for the same person.

Signing in on any one of their sign-in cards completes every other subagent waiting on that grant, and declining one declines the others, so none of them asks again this turn. A sign-in callback with the provider's `access_denied` now settles the sign-in as declined rather than as a retryable failure. A failed sign-in still settles only its own card. The parent calls each subagent's own callback, and each subagent settles it under its own principal, so no principal or credential passes between them. Sign-ins without a grant, for another principal, or minted by another deployment are still answered one by one.

---
"eve": patch
---

One answer now settles every parallel subagent waiting on the same Vercel Connect sign-in for the same person.

Signing in on any one of their sign-in cards completes every other subagent waiting on that grant, and a sign-in that comes back declined or failed ends the others the same way. The parent calls each subagent's own callback, and each subagent reads what Connect holds for its own principal, so no principal or credential passes between them. Sign-ins without a grant, for another principal, or minted by another deployment are still answered one by one.

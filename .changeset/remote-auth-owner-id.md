---
"eve": patch
---

Fixed remote `/vc:login` rejecting a freshly resolved Vercel project with "The local Vercel OIDC token does not match the resolved deployment: owner_id." The verified deployment now takes its owner id from Vercel's response instead of the team slug used to scope the lookup, so it matches the OIDC token's `owner_id` claim.

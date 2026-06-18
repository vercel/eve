---
"eve": minor
---

Remote `eve dev --url` sessions now verify the exact Vercel deployment before sending local credentials, show connection state, and run a cancellable `/vc:auth` flow when access is rejected. Vercel setup commands now use the `/vc:*` namespace, link without plugin onboarding, preserve required Trusted Sources rules, and search beyond the first project page.

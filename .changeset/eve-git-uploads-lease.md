---
"eve": patch
---

Fix `gh release upload` and `gh release create` with assets failing with 401 through the git extension's `gh` tool: the credential lease now covers `uploads.github.com`, not only `api.github.com` and `github.com`. A 401 there was also read as a revoked token and opened a sign-in for a user who was already signed in.

When Vercel Connect starts an authorization without a sign-in URL or device code, the user-scoped GitHub sign-in now fails with `ConnectionAuthorizationFailedError` instead of opening a sign-in prompt with no link.

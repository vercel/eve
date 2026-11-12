---
"eve": patch
---

Fail closed for repository-based authorization policies when GitHub commands use a caller's unscoped token.

User-mode `authorize` callbacks always receive `repository: null`, regardless of the command's declaration. Use GitHub App tokens with a full `owner/name` declaration for repository allowlists. Policies that intentionally permit the caller's full GitHub access can continue to authorize through `auth`.

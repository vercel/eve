---
"eve": patch
---

Store ChatGPT refresh credentials in the OS credential store using vendored just-secrets, with access tokens kept in memory. Existing users must sign in once through eve; a successful save removes the old plaintext session file.

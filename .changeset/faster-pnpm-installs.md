---
"@eve/self-modification": patch
---

Avoid rebuilding the self-modification extension during workspace installs. Its published artifacts are still built when the package is packed.

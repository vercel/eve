---
"eve": patch
---

New npm, Yarn, and Bun agents no longer receive an obsolete AI SDK package-manager pin. Web Chat installation now preserves the AI SDK version already declared by the agent, avoiding npm `EOVERRIDE` failures.

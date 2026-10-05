---
"eve": patch
---

Sessions saved before eve 0.64 that used a sandbox no longer fail every sandbox call with `Sandbox session state belongs to provider "undefined"` or the `Session checkpoint sandbox provider state is incompatible` handoff error. A sandbox record without a provider is treated as no sandbox, so the next sandbox call starts a fresh one.

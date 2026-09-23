---
"eve": patch
---

In `eve dev`, a running slash command shows `▪` in its gutter (still while a setup panel pulses beside it), and a finished one shows its status there as a gray `✓`, `⨯`, or `─`. The prompt `❯`, the user `│`, and typed slash commands are no longer colored or bold. When `/add`, `/login`, `/model`, or `/deploy` finishes, its row is replaced by a short dimmed summary such as `✓ Added connection/notion` or `✓ Model set to anthropic/claude-opus-4.6 minimal`. Details appear under the summary only when there is something to fix or resume. `/add` no longer keeps setup logs after the panel closes. Cancelling setup now shows the command to resume it instead of reporting a failure. Every setup flow now uses the same pulse indicator.

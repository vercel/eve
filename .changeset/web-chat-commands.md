---
"eve": patch
---

The Web Chat template and `useEveAgent` can list and run the eve channel's slash commands, so `/new`, `/clear`, and an agent's own commands work in the browser.

`useEveAgent` for React, Vue, and Svelte adds `commands()` and `runCommand(name, { argument })`. `runCommand` runs the command in the current session and applies its result: `send` goes out as the next message, and a command that ends the session starts a new one. `parseSlashCommand` from `eve/client` reads typed text as one of the listed commands. The Web Chat composer suggests commands as you type `/`, completes the first with Tab, and shows a command's `message` in the conversation.

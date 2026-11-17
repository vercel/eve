---
"eve": patch
---

Stop `eve init`'s terminal UI from flashing when it hands off to `eve dev`.
The screen it opens during the install now stays put until `eve dev` paints over it: a "Creating an eve agent" line above it turns into "Created an eve agent" in place, instead of the screen disappearing, printing that line, and reappearing a moment later. It also opens on the install's status instead of briefly showing "Starting agent…", `eve dev` no longer flashes a "Ready" status on the way to its chat prompt, and a model skipped during `eve init` shows as a `/login` setup issue in `eve dev`.

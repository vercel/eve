---
"eve": patch
---

Stop `eve init`'s terminal UI from flashing. The screen it opens during the install now stays up until `eve dev` paints over it, with "Created an eve agent" printed above it, instead of disappearing, printing that line, and reappearing a moment later. It also opens on the install's status instead of briefly showing "Starting agent…", and `eve dev` no longer flashes a "Ready" status on the way to its chat prompt.

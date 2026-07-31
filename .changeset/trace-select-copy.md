---
"eve": patch
---

The `/traces` viewer supports drag-to-select: dragging with the mouse highlights text and releasing copies it to the clipboard (OSC 52 with tmux passthrough, plus the platform clipboard command) with a confirmation toast. Clicks now act on release so drags never toggle cards, and Esc cancels an in-flight selection.

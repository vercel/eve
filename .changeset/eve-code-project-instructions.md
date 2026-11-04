---
"eve": minor
---

The code extension (`eve/extensions/code`) adds the workspace root's `AGENTS.md`, or `CLAUDE.md` when there is none, to the conversation, and its coding instructions now follow pi's tool guidance.

The extension reads the file with one sandbox command on the first turn, which starts the sandbox, and again only at the start of a turn that follows tool calls. A file over 64,000 bytes is cut off with a note that tells the model where to read the rest.

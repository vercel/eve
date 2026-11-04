---
"eve": minor
---

The code extension (`eve/extensions/code`) adds the workspace root's `AGENTS.md`, or `CLAUDE.md` when there is none, to the conversation before each turn, and its coding instructions now follow pi's tool guidance.

Reading the file starts the session's sandbox at the first model call of each turn. A file over 64,000 characters is cut off with a note that tells the model where to read the rest.

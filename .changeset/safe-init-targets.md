---
"eve": patch
---

Treat `eve init` targets as filesystem paths and classify non-empty targets before writing. When the generated initial Git commit fails, retain the repository and staged files and print the command to retry it.

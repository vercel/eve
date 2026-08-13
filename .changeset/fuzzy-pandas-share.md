---
"eve": minor
---

Allow a child sandbox definition to return `parent.sandbox`, reusing the dispatching parent's live sandbox across agent sessions. Parent and child collaborate on the shared `/workspace` working tree; each subagent additionally gets a private unix-style home directory (`/agents/{slug}`) holding its seeded workspace resources (`$HOME/workspace`), skill store (`$HOME/.agents/skills`), dotfiles, and caches. `$HOME` in subagent commands and paths resolves to that home, and a subagent's authored files never appear in the parent's tree.

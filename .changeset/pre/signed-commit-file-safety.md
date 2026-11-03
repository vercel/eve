---
"eve": patch
---

Prevent `gh-signed-commit` from publishing another file's contents for paths that resemble Git stage syntax or silently losing file modes and types.

The command now reads staged paths literally and rejects additions or updates involving executable files, symlinks, submodules, or mode changes before contacting GitHub. Staged changes remain intact; publish unsupported changes with native Git and a configured signing key.

---
"eve": minor
---

Import the custom skills tools from `eve/experimental/extensions/custom-skills` to offer them only to some sessions, such as behind a per-user feature flag.

Return a tool from `defineDynamic` in a same-named file in the mount directory to hide it, and return no scopes from `scopes` to hide saved skills. The extension's `manage` skill is now offered only when the session has a skill scope, so it disappears along with them.

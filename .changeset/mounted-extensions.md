---
"eve": patch
---

feat(eve): mounted extensions

Package eve capabilities — tools, connections, skills, instructions, hooks — as a reusable package and mount it under `agent/extensions/`, as a file (`crm.ts`) or a directory with co-located override slots that shadow the extension's own contributions. Contributions compose into the agent under a `<namespace>__` prefix. Author with `defineExtension` from `eve/extension`, taking an optional Standard-Schema `config` read via `extension.config`; `defineState` is auto-scoped to the package. `eve build` compiles the package to runnable JavaScript with type declarations and fills its `exports`, so a published extension installs and mounts with no second compiler. `eve` is a peer dependency whose declared range eve enforces at mount; an extension cannot declare a sandbox, agent config, schedules, or limits, or mount other extensions.

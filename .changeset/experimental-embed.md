---
"eve": minor
---

`eve/experimental/embed` runs an agent defined with `defineAgent` in your own process, with `createSession`, eve's default tools and sandboxes, and sessions kept on a Workflow World; `eve/experimental/embed/terminal` serves it to the `eve dev` terminal UI, and `eve/client` takes a `fetch` option.

The entries are experimental and may change without notice. `createSession` takes an explicit `identity` (`localUser()` for a CLI on its user's machine). `eve.defaults({ sandbox, without, approval })` lists the default tools, with `memorySandbox()`, `hostSandbox({ confine })` or `codeSandbox(environment)` for another environment such as Docker's. `localWorld({ dataDir })` keeps sessions in a directory, `listSessions(world)` lists them, and `createSession(agent, { world, resume })` and `runTerminal(agent, { name, world, resume })` continue one by id. `Client`'s `fetch` replaces the global `fetch` for every request the client makes, event streams included.

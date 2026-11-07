---
"eve": minor
---

`eve/browser` runs an agent defined with `defineAgent` in a browser page or Web Worker, with no server and no bundler configuration.

The entry is experimental and may change without notice. It shares one export list with `eve/experimental/embed` (`defineAgent`, `createSession`, `defineContext`, `eve.defaults()`, `memorySandbox()`, `listSessions()` and `memoryWorld()`) and adds `browserWorld()`, a World in the page's IndexedDB that keeps its sessions, `defineTool` and `always`. In a page, `memorySandbox()` keeps the shell's files in IndexedDB per session, and a step's tool calls run one at a time.

---
"eve": patch
---

Fix discovery of extension mounts written as `export { default } from "<pkg>"` inside a packaged extension, which `eve extension build` compiles to `import x from "<pkg>"; export { x as default };`.

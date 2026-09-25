---
"eve": patch
---

Treat `import "server-only"` as a no-op in authored modules, so channels, tools, and other agent files can import it without passing `--conditions=react-server`.

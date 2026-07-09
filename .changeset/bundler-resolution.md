---
"eve": patch
---

feat(eve): scaffold projects with bundler module resolution

`eve init` now writes a `tsconfig.json` using `"moduleResolution": "bundler"` (and `"module": "esnext"`), which matches how eve compiles authored agents and extensions. Relative imports in your agent and extension source no longer need `.js` extensions (e.g. `import extension from "../extension"`).

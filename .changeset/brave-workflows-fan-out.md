---
"eve": patch
---

Fix dynamic `Workflow` fan-out so concurrent subagent calls dispatch together and replay in deterministic program order. Generated pnpm workspaces now exempt the bundled code-mode package from release-age gating so fresh eve releases install immediately.

---
"eve": patch
---

Make `eve init` respect ancestor package-manager workspaces when scaffolding nested packages. The scaffold now updates workspace-owned package policy at the npm, pnpm, Yarn, or Bun workspace root instead of writing nested root-only config into the generated package.

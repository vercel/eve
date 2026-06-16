import { cp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const monorepoRoot = fileURLToPath(new URL("../../..", import.meta.url));

// The npm package README points at `./docs/...`, and scaffolded
// apps tell agents to read `node_modules/eve/docs/`. The
// package-local README is already listed in package.json#files; do not
// overwrite it with the monorepo root README.
const packageDocsDir = join(packageRoot, "docs");
const oldDistDocsDir = join(packageRoot, "dist", "docs");

await rm(packageDocsDir, { recursive: true, force: true });
await rm(oldDistDocsDir, { recursive: true, force: true });
await cp(join(monorepoRoot, "docs"), packageDocsDir, { recursive: true });

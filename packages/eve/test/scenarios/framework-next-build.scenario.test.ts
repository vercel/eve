import { fileURLToPath } from "node:url";

import { describe, it } from "vitest";

import { runPnpmCommand } from "../../src/internal/testing/run-pnpm-command.js";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

describe("framework-next build", () => {
  it("builds the Next.js framework fixture after regenerating eve dist", async () => {
    await runPnpmCommand({
      args: ["--filter", "framework-next", "build"],
      cwd: REPO_ROOT,
    });
  }, 180_000);
});

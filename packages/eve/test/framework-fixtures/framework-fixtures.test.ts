import { fileURLToPath } from "node:url";

import { describe, it } from "vitest";

import { runPnpmCommand } from "../../src/internal/testing/run-pnpm-command.js";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

describe("framework fixtures", () => {
  it.each([
    "framework-next",
    "framework-nuxt",
    "framework-solid",
    "framework-sveltekit",
    "framework-tanstack",
    "framework-vite",
  ])(
    "builds the %s fixture against the workspace eve dist",
    async (fixture) => {
      await runPnpmCommand({
        args: ["--filter", fixture, "build"],
        cwd: REPO_ROOT,
      });
    },
    300_000,
  );
});

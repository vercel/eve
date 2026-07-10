import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, it, vi } from "vitest";

import { runPnpmCommand } from "../../src/internal/testing/run-pnpm-command.js";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("framework-next-better-auth build", () => {
  it("builds the Better Auth Next.js framework fixture after regenerating eve dist", async () => {
    vi.stubEnv("BETTER_AUTH_DATABASE_PATH", join(tmpdir(), "eve-better-auth-build.sqlite"));
    vi.stubEnv("BETTER_AUTH_SECRET", "scenario-secret-at-least-32-characters");
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");

    await runPnpmCommand({
      args: ["--filter", "framework-next-better-auth", "build"],
      cwd: REPO_ROOT,
    });
  }, 180_000);
});

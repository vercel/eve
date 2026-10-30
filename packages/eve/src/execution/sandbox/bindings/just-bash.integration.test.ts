import { describe, expect, it, vi } from "vitest";

import { createSandboxEnvironmentHarness } from "#internal/testing/sandbox-provider-harness.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";
import { JustBashSandbox, type JustBashEnvironmentOptions } from "#sandbox/providers/just-bash.js";

vi.mock("just-bash", () => {
  throw new Error("Cannot find module 'just-bash'");
});

const createScratchDirectory = useTemporaryDirectories();

function createJustBashProvider(options?: JustBashEnvironmentOptions) {
  return createSandboxEnvironmentHarness(JustBashSandbox.environment(options));
}

describe("just-bash provider without the optional dependency installed", () => {
  it("fails with an actionable install hint outside eve dev", async () => {
    const appRoot = await createScratchDirectory("eve-just-bash-missing-");
    const provider = createJustBashProvider();
    await expect(
      provider.openSession({
        appRoot,
        sandboxName: "session-missing-dependency",
      }),
    ).rejects.toThrow(/pnpm add -D just-bash/);
  });

  it("fails without installing when autoInstall is disabled, even in eve dev", async () => {
    vi.stubEnv("EVE_DEV", "1");
    try {
      const appRoot = await createScratchDirectory("eve-just-bash-no-autoinstall-");
      const provider = createJustBashProvider({ autoInstall: false });
      await expect(
        provider.openSession({
          appRoot,
          sandboxName: "session-no-autoinstall",
        }),
      ).rejects.toThrow(/pnpm add -D just-bash/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

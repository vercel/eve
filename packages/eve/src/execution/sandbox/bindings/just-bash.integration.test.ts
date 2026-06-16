import { describe, expect, it, vi } from "vitest";

import { createJustBashSandboxBackend } from "#execution/sandbox/bindings/just-bash.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";

// Simulate an application that configured the just-bash backend without
// the optional `just-bash` package being installed or installable.
vi.mock("just-bash", () => {
  throw new Error("Cannot find module 'just-bash'");
});

const createScratchDirectory = useTemporaryDirectories();

describe("just-bash backend without the optional dependency installed", () => {
  it("fails with an actionable install hint outside eve dev", async () => {
    const appRoot = await createScratchDirectory("eve-just-bash-missing-");
    const backend = createJustBashSandboxBackend();

    // Outside `eve dev` (no EVE_DEV flag) the loader must not attempt a
    // package-manager install — it fails actionably instead.
    await expect(
      backend.create({
        runtimeContext: { appRoot },
        sessionKey: "session-missing-dependency",
        templateKey: null,
      }),
    ).rejects.toThrow(/pnpm add -D just-bash/);
  });

  it("fails without installing when autoInstall is disabled, even in eve dev", async () => {
    vi.stubEnv("EVE_DEV", "1");
    try {
      const appRoot = await createScratchDirectory("eve-just-bash-no-autoinstall-");
      const backend = createJustBashSandboxBackend({ createOptions: { autoInstall: false } });

      await expect(
        backend.create({
          runtimeContext: { appRoot },
          sessionKey: "session-no-autoinstall",
          templateKey: null,
        }),
      ).rejects.toThrow(/pnpm add -D just-bash/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

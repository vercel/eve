import { describe, expect, it, vi } from "vitest";
import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { packageInstallResult } from "#internal/testing/package-process.js";
import { installScaffoldDependencies } from "./scaffold.js";

describe("integration dependency installation", () => {
  it.each([true, false])("handles a failed install with required=%s", async (required) => {
    const fake = createFakePrompter();
    const install = installScaffoldDependencies({
      changed: true,
      required,
      projectPath: "/project",
      log: fake.prompter.log,
      deps: {
        detectPackageManager: async () => ({ kind: "pnpm", source: "lockfile" }),
        runPackageManagerInstall: vi.fn(async () => packageInstallResult(1)),
      },
    });
    if (required) {
      await expect(install).rejects.toThrow("pnpm install");
    } else {
      await expect(install).resolves.toBeUndefined();
      expect(fake.prompter.log.warning).toHaveBeenCalledWith(
        expect.stringContaining("pnpm install"),
      );
    }
  });
});

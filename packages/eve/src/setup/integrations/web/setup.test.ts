import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";

import { integrationSetupEnvironment } from "../shared/environment.js";
import { createIntegrationSetupUi } from "../shared/ui.js";
import { WEB_SETUP } from "./setup.js";

const { detectPackageManager, ensureChannel } = vi.hoisted(() => ({
  detectPackageManager: vi.fn(async () => ({ kind: "pnpm" as const })),
  ensureChannel: vi.fn(async () => ({
    action: "overwritten" as const,
    filesSkipped: [],
    filesWritten: [],
    kind: "web" as const,
    packageJsonUpdated: [],
  })),
}));

vi.mock("#setup/package-manager.js", () => ({ detectPackageManager }));
vi.mock("#setup/scaffold/index.js", () => ({ ensureChannel }));

describe("WEB_SETUP", () => {
  it("reconciles files already installed by the registry", async () => {
    const fake = createFakePrompter();

    await WEB_SETUP.setup({
      appRoot: "/project",
      environment: integrationSetupEnvironment("logged-out", { kind: "unresolved" }),
      ui: createIntegrationSetupUi({
        asker: { ask: vi.fn(), askMany: vi.fn() },
        prompter: fake.prompter,
      }),
    });

    expect(ensureChannel).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "web", registryItemInstalled: true }),
    );
  });
});

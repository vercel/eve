import { describe, expect, it, vi } from "vitest";
import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { headlessAsker } from "#setup/ask.js";
import { integrationSetupEnvironment } from "../shared/environment.js";
import { createSetupContexts } from "../shared/ui.js";
import { applyWebSetup, prepareWebSetup, type WebSetupDeps } from "./setup.js";

function deps(): WebSetupDeps {
  return {
    detectPackageManager: vi.fn(async () => ({
      kind: "pnpm" as const,
      source: "lockfile" as const,
    })),
    ensureChannel: vi.fn(async () => ({
      kind: "web" as const,
      action: "created" as const,
      filesWritten: [],
      filesOverwritten: [],
      filesSkipped: [],
      packageJsonUpdated: [
        { path: "/project/package.json", dependencies: ["eve"], devDependencies: [], scripts: [] },
      ],
      nodeEngineOverride: undefined,
      competingNextConfigFiles: [],
    })),
    installScaffoldDependencies: vi.fn(async () => {}),
  };
}

describe("Web setup", () => {
  it("prepares and applies without semantic questions", async () => {
    const effects = deps();
    const ctx = createSetupContexts({
      appRoot: "/project",
      asker: headlessAsker(),
      environment: integrationSetupEnvironment("cli-missing", { kind: "unresolved" }),
      prompter: createFakePrompter().prompter,
    });
    const plan = await prepareWebSetup(ctx.prepare, effects);
    await applyWebSetup(plan, ctx.apply, effects);
    expect(effects.ensureChannel).toHaveBeenCalledWith(
      expect.objectContaining({ configureVercelServices: false, skipDependencyMutation: true }),
    );
    expect(effects.installScaffoldDependencies).toHaveBeenCalledWith(
      expect.objectContaining({ changed: true, projectPath: "/project" }),
    );
  });
});

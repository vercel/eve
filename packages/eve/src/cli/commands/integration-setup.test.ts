import { afterEach, describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import type { AddChannelsDeps } from "#setup/integrations/channel-scaffold.js";
import type { IntegrationSetupRunnerDeps } from "#setup/integrations/runner.js";
import { deriveSlackConnectorSlug } from "#setup/scaffold/index.js";

import { runIntegrationSetupCommand } from "./integration-setup.js";
import type { RegistryCommandLogger } from "./registry.js";

const { isEveProject } = vi.hoisted(() => ({ isEveProject: vi.fn(async () => true) }));

vi.mock("#setup/scaffold/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#setup/scaffold/index.js")>()),
  isEveProject,
}));

function logger(): RegistryCommandLogger & { errors: string[] } {
  const errors: string[] = [];
  return { errors, error: (message) => errors.push(message), log: () => {} };
}

function addChannelsDeps(): AddChannelsDeps {
  return {
    ensureChannel: vi.fn<AddChannelsDeps["ensureChannel"]>(async (options) => ({
      kind: "web",
      action: "created",
      filesWritten: [`${options.projectRoot}/app/page.tsx`],
      filesSkipped: [],
      packageJsonUpdated: [],
    })),
    deriveSlackConnectorSlug,
    provisionSlackbot: vi.fn(),
    reconcileSlackUid: vi.fn(async () => true),
    detectPackageManager: vi.fn<AddChannelsDeps["detectPackageManager"]>(async () => ({
      kind: "pnpm",
      source: "default",
    })),
    runPackageManagerInstall: vi.fn(async () => true),
    ensureVercelProject: vi.fn(async () => ({ orgId: "team-id", projectId: "project-id" })),
  };
}

afterEach(() => {
  process.exitCode = undefined;
});

describe("runIntegrationSetupCommand", () => {
  it("runs registry-owned setup without mutating or installing dependencies", async () => {
    const output = logger();
    const deps = addChannelsDeps();
    const fake = createFakePrompter();

    await runIntegrationSetupCommand(
      output,
      "/project",
      "web",
      {},
      {
        createPrompter: () => fake.prompter,
        runnerDeps: {
          detectDeployment: vi.fn(async () => ({ state: "unlinked" as const })),
          getVercelAuthStatus: vi.fn(async () => "cli-missing" as const),
          addChannelsDeps: deps,
        } satisfies IntegrationSetupRunnerDeps,
      },
    );

    expect(deps.ensureChannel).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "web", skipDependencyMutation: true }),
    );
    expect(deps.runPackageManagerInstall).not.toHaveBeenCalled();
    expect(output.errors).toEqual([]);
  });
});

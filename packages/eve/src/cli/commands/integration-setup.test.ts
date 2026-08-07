import { afterEach, describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { ensureVercelProject } from "#setup/flows/ensure-vercel-project.js";
import { runIntegrationSetup } from "#setup/integrations/runner.js";

import { runIntegrationSetupCommand } from "./integration-setup.js";
import type { RegistryCommandLogger } from "./registry.js";

const { isEveProject } = vi.hoisted(() => ({ isEveProject: vi.fn(async () => true) }));

vi.mock("#setup/scaffold/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#setup/scaffold/index.js")>()),
  isEveProject,
}));
vi.mock("#setup/integrations/runner.js", () => ({ runIntegrationSetup: vi.fn() }));
vi.mock("#setup/flows/ensure-vercel-project.js", () => ({ ensureVercelProject: vi.fn() }));

function logger(): RegistryCommandLogger & { errors: string[] } {
  const errors: string[] = [];
  return { errors, error: (message) => errors.push(message), log: () => {} };
}

afterEach(() => {
  process.exitCode = undefined;
  vi.clearAllMocks();
});

describe("runIntegrationSetupCommand", () => {
  it("delegates registry-owned setup to the integration runner", async () => {
    vi.mocked(runIntegrationSetup).mockResolvedValue({
      kind: "done",
      completion: { facts: [] },
    });
    const output = logger();
    const fake = createFakePrompter();

    await runIntegrationSetupCommand(
      output,
      "/project",
      "web",
      {},
      {
        createPrompter: () => fake.prompter,
      },
    );

    expect(runIntegrationSetup).toHaveBeenCalledWith(
      "web",
      expect.objectContaining({
        appRoot: "/project",
        prompter: fake.prompter,
        resolveVercelProject: expect.any(Function),
      }),
      undefined,
    );
    const resolveVercelProject =
      vi.mocked(runIntegrationSetup).mock.calls[0]?.[1].resolveVercelProject;
    await resolveVercelProject?.("GitHub");
    expect(ensureVercelProject).toHaveBeenCalledWith({
      appRoot: "/project",
      prompter: fake.prompter,
      signal: undefined,
    });
    expect(output.errors).toEqual([]);
  });
});

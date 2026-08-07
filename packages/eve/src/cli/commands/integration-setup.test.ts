import { afterEach, describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { InteractionRequired, select } from "#setup/ask.js";
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

  it("passes answer-backed headless setup to the runner", async () => {
    vi.mocked(runIntegrationSetup).mockImplementation(async (_kind, options) => {
      await expect(
        options.asker?.ask(
          select({
            key: "mode",
            message: "Mode?",
            options: [{ id: "portable", label: "Portable", value: "environment" }],
            required: true,
          }),
        ),
      ).resolves.toBe("environment");
      expect(options.asker).toBeDefined();
      return { kind: "done", completion: { facts: [] } };
    });

    await runIntegrationSetupCommand(logger(), "/project", "web", {
      headless: true,
      answers: { mode: "portable" },
    });
  });

  it("serializes structured missing input in headless JSON mode", async () => {
    vi.mocked(runIntegrationSetup).mockRejectedValue(
      new InteractionRequired(
        select({ key: "mode", message: "Mode?", options: [], required: true }),
      ),
    );
    const output = logger();

    await runIntegrationSetupCommand(output, "/project", "web", { headless: true });

    expect(JSON.parse(output.errors[0]!)).toMatchObject({
      status: "input_required",
      type: "blocked",
      question: { key: "mode" },
    });
  });
});

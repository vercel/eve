import { afterEach, describe, expect, it, vi } from "vitest";

import type { EveProjectContext } from "#internal/project-context.js";
import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { InteractionRequired, select } from "#setup/ask.js";
import { ensureVercelProject } from "#setup/flows/ensure-vercel-project.js";
import { runIntegrationSetup } from "#setup/integrations/runner.js";

import { runIntegrationSetupCommand } from "./integration-setup.js";
import type { RegistryCommandLogger } from "./registry.js";

const { isEveProject, resolveEveProjectContext } = vi.hoisted(() => ({
  isEveProject: vi.fn(async () => true),
  resolveEveProjectContext: vi.fn(async (appRoot: string): Promise<EveProjectContext> => ({
    appRoot,
    environmentRoot: appRoot,
    kind: "standalone",
  })),
}));

class SetupProcess {
  connected = true;
  readonly sent: unknown[] = [];
  send = (message: unknown) => {
    this.sent.push(message);
    return true;
  };
  disconnect() {}
  on() {}
  off() {}
}

vi.mock("#setup/scaffold/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#setup/scaffold/index.js")>()),
  isEveProject,
}));
vi.mock("#setup/integrations/runner.js", () => ({ runIntegrationSetup: vi.fn() }));
vi.mock("#internal/project-context.js", () => ({ resolveEveProjectContext }));
vi.mock("#setup/flows/ensure-vercel-project.js", () => ({ ensureVercelProject: vi.fn() }));

function logger(): RegistryCommandLogger & { errors: string[] } {
  const errors: string[] = [];
  return { errors, error: (message) => errors.push(message), log: () => {} };
}

const fakePrompterDeps = { createPrompter: () => createFakePrompter().prompter };

afterEach(() => {
  process.exitCode = undefined;
  vi.unstubAllEnvs();
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

  it("rediscovers the shared project root from a workspace agent", async () => {
    resolveEveProjectContext.mockResolvedValueOnce({
      environmentRoot: "/workspace",
      kind: "workspace-member",
      member: { appRoot: "/workspace/agents/support", name: "support" },
      workspace: {
        root: "/workspace",
        members: [{ appRoot: "/workspace/agents/support", name: "support" }],
      },
    });
    vi.mocked(runIntegrationSetup).mockResolvedValue({
      kind: "done",
      completion: { facts: [] },
    });

    await runIntegrationSetupCommand(
      logger(),
      "/workspace/agents/support",
      "slack",
      {},
      fakePrompterDeps,
    );

    expect(runIntegrationSetup).toHaveBeenCalledWith(
      "slack",
      expect.objectContaining({
        appRoot: "/workspace/agents/support",
        projectRoot: "/workspace",
      }),
      undefined,
    );
  });

  it("passes force to the integration runner", async () => {
    vi.mocked(runIntegrationSetup).mockResolvedValue({
      kind: "done",
      completion: { facts: [] },
    });

    await runIntegrationSetupCommand(
      logger(),
      "/project",
      "photon",
      { force: true },
      fakePrompterDeps,
    );

    expect(runIntegrationSetup).toHaveBeenCalledWith(
      "photon",
      expect.objectContaining({ force: true }),
      undefined,
    );
  });

  it("assumes recommended setup answers with --yes in interactive mode", async () => {
    vi.mocked(runIntegrationSetup).mockImplementation(async (_kind, options) => {
      await expect(
        options.asker?.ask(
          select({
            key: "mode",
            message: "Mode?",
            options: [{ id: "portable", label: "Portable", value: "environment" }],
            recommended: "environment",
            required: true,
          }),
        ),
      ).resolves.toBe("environment");
      return { kind: "done", completion: { facts: [] } };
    });

    await runIntegrationSetupCommand(logger(), "/project", "web", { yes: true }, fakePrompterDeps);
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
      nonInteractive: true,
      answers: { mode: "portable" },
    });
  });

  it("marks external actions as blocking while the command keeps running", async () => {
    const output = logger();
    const logs: string[] = [];
    output.log = (message) => logs.push(message);
    vi.mocked(runIntegrationSetup).mockImplementation(async (_kind, options) => {
      const action = options.beginExternalAction?.({
        message: "Authorize Photon",
        url: "https://example.com/device",
        userCode: "ABCD1234",
      });
      action?.complete();
      return { kind: "done", completion: { facts: [] } };
    });

    await runIntegrationSetupCommand(output, "/project", "photon", { nonInteractive: true });

    expect(JSON.parse(logs[0]!)).toMatchObject({
      version: 1,
      type: "external_action",
      blocking: true,
      message: "Authorize Photon",
      url: "https://example.com/device",
      userCode: "ABCD1234",
    });
    const started = JSON.parse(logs[0]!) as { id: string };
    expect(JSON.parse(logs[1]!)).toEqual({
      version: 1,
      type: "external_action_resolved",
      id: started.id,
    });
  });

  it("leaves blocked event ownership to the parent setup process", async () => {
    const previousProtocol = process.env.EVE_SETUP_PROTOCOL;
    process.env.EVE_SETUP_PROTOCOL = "2";
    const setupProcess = new SetupProcess();
    const output = logger();
    vi.mocked(runIntegrationSetup).mockRejectedValue(
      new InteractionRequired(
        select({ key: "mode", message: "Mode?", options: [], required: true }),
      ),
    );

    try {
      await runIntegrationSetupCommand(
        output,
        "/project",
        "web",
        { nonInteractive: true },
        {
          setupProcess,
        },
      );
    } finally {
      if (previousProtocol === undefined) delete process.env.EVE_SETUP_PROTOCOL;
      else process.env.EVE_SETUP_PROTOCOL = previousProtocol;
    }

    expect(output.errors).toEqual([]);
    expect(setupProcess.sent).toContainEqual(
      expect.objectContaining({
        type: "result",
        outcome: expect.objectContaining({ kind: "blocked" }),
      }),
    );
  });

  it("serializes structured missing input in headless JSON mode", async () => {
    vi.mocked(runIntegrationSetup).mockRejectedValue(
      new InteractionRequired(
        select({ key: "mode", message: "Mode?", options: [], required: true }),
      ),
    );
    const output = logger();

    await runIntegrationSetupCommand(output, "/project", "web", { nonInteractive: true });

    expect(JSON.parse(output.errors[0]!)).toMatchObject({
      status: "input_required",
      type: "blocked",
      question: { key: "mode" },
    });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

import { captureVercel, type VercelCaptureResult } from "#setup/primitives/index.js";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";

import { headlessAsker, interactiveAsker } from "../ask.js";
import type { ProjectResolution } from "../project-resolution.js";
import type {
  EditableSelectOptions,
  EditableSelectResult,
  Prompter,
  PrompterValue,
  SingleSelectOptions,
} from "../prompter.js";
import {
  createDefaultSetupState,
  type ConnectionPlan,
  type ProvisioningMode,
  type SetupState,
} from "../state.js";
import type { OutputSink } from "../step.js";
import { runHeadless, runInteractive } from "../runner.js";
import {
  resolveProvisioning,
  type ResolveProvisioningDeps,
  type ResolveProvisioningOptions,
} from "./resolve-provisioning.js";

vi.mock("#setup/primitives/index.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("#setup/primitives/index.js")>();
  return { ...original, captureVercel: vi.fn() };
});

const mockedCaptureVercel = vi.mocked(captureVercel);

const silentSink: OutputSink = { write: () => {} };

function fakeDeps(): ResolveProvisioningDeps {
  return {
    requireAuth: vi.fn(async () => {}),
    isVercelAuthenticated: vi.fn(async () => true),
    detectProjectResolution: vi.fn(
      async (): Promise<ProjectResolution> => ({
        kind: "unresolved",
      }),
    ),
    pathExists: vi.fn(async () => true),
    validateTeam: vi.fn(async () => {}),
    resolveTeam: vi.fn(async () => "team"),
    pickTeam: vi.fn(async () => "team"),
    pickProject: vi.fn(async () => ({
      kind: "existing" as const,
      project: { projectId: "prj_existing", projectName: "existing-project" },
      team: "team",
    })),
    pickNewProjectName: vi.fn(async (_prompter, _parent, _team, project: string) => project),
    assertNewProjectNameAvailable: vi.fn(async () => {}),
    resolveProjectByNameOrId: vi.fn(async () => ({
      projectId: "prj_existing",
      projectName: "existing-project",
    })),
  };
}

function unexpectedPrompt(): never {
  throw new Error("Unexpected prompt in a resolve-provisioning test.");
}

function createPrompter(
  options: { selectValues?: PrompterValue[]; passwordValue?: string } = {},
): Prompter {
  const selectValues = [...(options.selectValues ?? [])];
  return createFakePrompter({
    password: () => options.passwordValue ?? unexpectedPrompt(),
    single: () => selectValues.shift() ?? unexpectedPrompt(),
  }).prompter;
}

function stateWithAgentName(agentName: string): SetupState {
  return { ...createDefaultSetupState(), agentName };
}

/** A Connect-backed connection plan, as the select-connections box records it. */
function connectPlan(slug: string): ConnectionPlan {
  return {
    slug,
    protocol: "mcp",
    entry: { slug, auth: { kind: "connect", connector: slug } } as ConnectionPlan["entry"],
    provision: { kind: "connect", service: `mcp.${slug}.app` },
  };
}

/**
 * Composes the ask channel the way the onboarding site does: the headless base
 * when `mode.headless`, the interactive base over the test prompter otherwise.
 * The deploy-tree questions travel the asker by option id, so the interactive
 * `selectValues` are the option ids ("vercel"/"local"/"new"/"link"/"api-key"),
 * not the rich values the old `prompter.select<boolean>` returned directly.
 */
function makeBox(
  options: Omit<ResolveProvisioningOptions, "asker"> & { mode: ProvisioningMode },
): ReturnType<typeof resolveProvisioning> {
  return resolveProvisioning({
    ...options,
    asker: options.mode.headless ? headlessAsker() : interactiveAsker(options.prompter),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveProvisioning box", () => {
  it("maps headless flags to project and AI Gateway plans without prompting", async () => {
    const deps = fakeDeps();
    const prompter = createPrompter();
    const box = makeBox({
      prompter,
      targetDirectory: "/tmp/parent",
      mode: { headless: true, project: { team: "team" }, aiGateway: {} },
      deps,
    });

    const next = await runHeadless([box], stateWithAgentName("my-agent"), silentSink);

    expect(next.vercelProject).toEqual({ kind: "new", project: "my-agent", team: "team" });
    expect(next.aiGateway).toEqual({ kind: "inherit" });
    expect(next.modelWiring).toBe("gateway");
    expect(deps.requireAuth).toHaveBeenCalledWith("/tmp/parent", undefined, { signal: undefined });
    expect(deps.validateTeam).toHaveBeenCalledWith(expect.anything(), "/tmp/parent", "team", {
      signal: undefined,
    });
    expect(deps.resolveTeam).toHaveBeenCalledWith("/tmp/parent", "team", { signal: undefined });
    expect(deps.assertNewProjectNameAvailable).toHaveBeenCalledWith(
      "/tmp/parent",
      "team",
      "my-agent",
      { signal: undefined },
    );
  });

  it("maps headless local provider setup to byop", async () => {
    const deps = fakeDeps();
    const box = makeBox({
      prompter: createPrompter(),
      targetDirectory: "/tmp/parent",
      mode: { headless: true, project: { skipVercel: true }, aiGateway: {} },
      deps,
    });

    const next = await runHeadless([box], stateWithAgentName("my-agent"), silentSink);

    expect(next.vercelProject).toEqual({ kind: "none" });
    expect(next.aiGateway).toEqual({ kind: "byop" });
    expect(next.modelWiring).toBe("self");
    expect(deps.requireAuth).not.toHaveBeenCalled();
  });

  it("resolves a headless project name before recording the plan", async () => {
    const deps = fakeDeps();
    const box = makeBox({
      prompter: createPrompter(),
      targetDirectory: "/tmp/parent",
      mode: {
        headless: true,
        project: { team: "team", project: "existing-project" },
        aiGateway: {},
      },
      deps,
    });

    const next = await runHeadless([box], stateWithAgentName("my-agent"), silentSink);

    expect(next.vercelProject).toEqual({
      kind: "existing",
      project: { projectId: "prj_existing", projectName: "existing-project" },
      team: "team",
    });
    expect(deps.resolveProjectByNameOrId).toHaveBeenCalledWith(
      "/tmp/parent",
      "team",
      "existing-project",
      { signal: undefined },
    );
  });

  it("rejects a missing headless project before recording the plan", async () => {
    const deps = fakeDeps();
    deps.resolveProjectByNameOrId = vi.fn(async () => null);
    const box = makeBox({
      prompter: createPrompter(),
      targetDirectory: "/tmp/parent",
      mode: {
        headless: true,
        project: { team: "team", project: "missing" },
        aiGateway: {},
      },
      deps,
    });

    await expect(runHeadless([box], stateWithAgentName("my-agent"), silentSink)).rejects.toThrow(
      'Vercel project "missing" was not found in team.',
    );
  });

  it("rejects headless Vercel provisioning without an explicit team", async () => {
    const deps = fakeDeps();
    const box = makeBox({
      prompter: createPrompter(),
      targetDirectory: "/tmp/parent",
      mode: { headless: true, project: {}, aiGateway: {} },
      deps,
    });

    await expect(runHeadless([box], stateWithAgentName("my-agent"), silentSink)).rejects.toThrow(
      "requires --team <slug> or --scope <slug>",
    );
    expect(deps.requireAuth).not.toHaveBeenCalled();
  });

  it("keeps the create-or-link question for onboarding and uses the replacement name", async () => {
    const deps = fakeDeps();
    deps.pickNewProjectName = vi.fn(async () => "my-agent-2");
    const answers: PrompterValue[] = ["vercel", "new"];
    const { prompter, selectMessages } = createFakePrompter({
      single: () => answers.shift() ?? unexpectedPrompt(),
    });
    const box = makeBox({
      prompter,
      targetDirectory: "/tmp/parent",
      mode: { headless: false },
      deps,
    });

    const result = await runInteractive([box], stateWithAgentName("my-agent"), silentSink);

    expect(result.kind).toBe("done");
    if (result.kind !== "done") return;
    expect(result.state.vercelProject).toEqual({
      kind: "new",
      project: "my-agent-2",
      team: "team",
    });
    expect(selectMessages).toEqual(["Where should your agent run?", "Vercel project"]);
    expect(deps.pickNewProjectName).toHaveBeenCalledWith(
      expect.anything(),
      "/tmp/parent",
      "team",
      "my-agent",
      { signal: undefined },
    );
  });

  it("checks an inline-edited project name instead of the directory default", async () => {
    const deps = fakeDeps();
    const prompter = createPrompter({ selectValues: ["vercel"] });
    prompter.selectEditable = async <T extends PrompterValue>(
      opts: EditableSelectOptions<T>,
    ): Promise<EditableSelectResult<T>> => ({
      kind: "edited",
      value: opts.editable.value,
      text: "custom-project",
    });
    const box = makeBox({
      prompter,
      targetDirectory: "/tmp/parent",
      mode: { headless: false },
      deps,
    });

    const result = await runInteractive([box], stateWithAgentName("my-agent"), silentSink);

    expect(result.kind).toBe("done");
    if (result.kind !== "done") return;
    expect(result.state.vercelProject).toEqual({
      kind: "new",
      project: "custom-project",
      team: "team",
    });
    expect(deps.pickNewProjectName).toHaveBeenCalledWith(
      expect.anything(),
      "/tmp/parent",
      "team",
      "custom-project",
      { signal: undefined },
    );
  });

  it("plans a new project when the Q3 link branch returns a typed-in name", async () => {
    const deps = fakeDeps();
    deps.pickProject = vi.fn(async () => ({
      kind: "new" as const,
      project: "typed-agent",
      team: "team",
    }));
    const box = makeBox({
      prompter: createPrompter({ selectValues: ["vercel", "link"] }),
      targetDirectory: "/tmp/parent",
      mode: { headless: false },
      deps,
    });

    const result = await runInteractive([box], stateWithAgentName("my-agent"), silentSink);

    expect(result.kind).toBe("done");
    if (result.kind !== "done") return;
    expect(result.state.vercelProject).toEqual({
      kind: "new",
      project: "typed-agent",
      team: "team",
    });
  });

  it("records the local API-key branch from the Q3 prompt", async () => {
    const box = makeBox({
      prompter: createPrompter({ selectValues: ["local", "api-key"], passwordValue: "sk-test" }),
      targetDirectory: "/tmp/parent",
      mode: { headless: false },
      deps: fakeDeps(),
    });

    const result = await runInteractive([box], stateWithAgentName("my-agent"), silentSink);

    expect(result.kind).toBe("done");
    if (result.kind !== "done") return;
    expect(result.state.vercelProject).toEqual({ kind: "none" });
    expect(result.state.aiGateway).toEqual({ kind: "byok", apiGatewayKey: "sk-test" });
    expect(result.state.modelWiring).toBe("gateway");
  });

  it("records the wire-your-own-provider branch as self model wiring", async () => {
    const box = makeBox({
      prompter: createPrompter({ selectValues: ["local", "local"] }),
      targetDirectory: "/tmp/parent",
      mode: { headless: false },
      deps: fakeDeps(),
    });

    const result = await runInteractive([box], stateWithAgentName("my-agent"), silentSink);

    expect(result.kind).toBe("done");
    if (result.kind !== "done") return;
    expect(result.state.aiGateway).toEqual({ kind: "byop" });
    expect(result.state.modelWiring).toBe("self");
  });

  it("adopts a detected on-disk link with a logged-in CLI, asking nothing", async () => {
    const deps = fakeDeps();
    deps.detectProjectResolution = vi.fn(
      async (): Promise<ProjectResolution> => ({ kind: "linked", projectId: "prj_demo" }),
    );
    // A prompter with no configured answers: any select or password throws,
    // proving the adopted link resolves every provisioning question.
    const prompter = createPrompter();
    const box = makeBox({
      prompter,
      targetDirectory: "/tmp/parent",
      mode: { headless: false },
      deps,
    });
    const state: SetupState = {
      ...stateWithAgentName("my-agent"),
      projectPath: { kind: "resolved", inPlace: true, path: "/tmp/parent/app" },
    };

    const result = await runInteractive([box], state, silentSink);

    expect(result.kind).toBe("done");
    if (result.kind !== "done") return;
    expect(result.state.project).toEqual({ kind: "linked", projectId: "prj_demo" });
    // The link is the source of truth: no project plan, gateway inherited
    // (the runtime mints an OIDC token from the login + link).
    expect(result.state.vercelProject).toEqual({ kind: "none" });
    expect(result.state.aiGateway).toEqual({ kind: "inherit" });
    expect(result.state.modelWiring).toBe("gateway");
    expect(deps.pickTeam).not.toHaveBeenCalled();
    expect(deps.requireAuth).not.toHaveBeenCalled();
    expect(prompter.log.info).toHaveBeenCalledWith(
      expect.stringContaining("already linked to a Vercel project"),
    );
  });

  it("asks the question tree when the linked directory has no CLI login", async () => {
    const deps = fakeDeps();
    deps.detectProjectResolution = vi.fn(
      async (): Promise<ProjectResolution> => ({ kind: "linked", projectId: "prj_demo" }),
    );
    deps.isVercelAuthenticated = vi.fn(async () => false);
    const box = makeBox({
      prompter: createPrompter({ selectValues: ["vercel", "new"] }),
      targetDirectory: "/tmp/parent",
      mode: { headless: false },
      deps,
    });
    const state: SetupState = {
      ...stateWithAgentName("my-agent"),
      projectPath: { kind: "resolved", inPlace: true, path: "/tmp/parent/app" },
    };

    const result = await runInteractive([box], state, silentSink);

    expect(result.kind).toBe("done");
    if (result.kind !== "done") return;
    // A link without a login cannot mint an OIDC token, so the run falls
    // back to the questions, whose Vercel branch enforces login.
    expect(result.state.vercelProject).toEqual({ kind: "new", project: "my-agent", team: "team" });
    expect(deps.requireAuth).toHaveBeenCalled();
  });

  it("resolves to Vercel without asking when Slack was selected earlier", async () => {
    const deps = fakeDeps();
    // Only the project sub-question is asked; the where-to-run select would
    // consume a value the prompter does not have, so reaching it throws.
    const prompter = createPrompter({ selectValues: ["new"] });
    const box = makeBox({
      prompter,
      targetDirectory: "/tmp/parent",
      mode: { headless: false },
      deps,
    });
    const state: SetupState = { ...stateWithAgentName("my-agent"), channelSelection: ["slack"] };

    const result = await runInteractive([box], state, silentSink);

    expect(result.kind).toBe("done");
    if (result.kind !== "done") return;
    expect(result.state.vercelProject).toEqual({ kind: "new", project: "my-agent", team: "team" });
    expect(prompter.log.info).toHaveBeenCalledWith(
      "Slack needs a public URL, so your agent will run on Vercel.",
    );
  });

  it("resolves to Vercel without asking when a Connect-backed connection was selected", async () => {
    const deps = fakeDeps();
    const prompter = createPrompter({ selectValues: ["new"] });
    const box = makeBox({
      prompter,
      targetDirectory: "/tmp/parent",
      mode: { headless: false },
      deps,
    });
    const state: SetupState = {
      ...stateWithAgentName("my-agent"),
      connectionSelection: [connectPlan("linear")],
    };

    const result = await runInteractive([box], state, silentSink);

    expect(result.kind).toBe("done");
    if (result.kind !== "done") return;
    expect(result.state.vercelProject).toEqual({ kind: "new", project: "my-agent", team: "team" });
    expect(prompter.log.info).toHaveBeenCalledWith(
      "linear authenticates through Vercel Connect, so your agent will run on Vercel.",
    );
  });

  it("derives the provider key hint from the model picked earlier", async () => {
    const asked: SingleSelectOptions<PrompterValue>[] = [];
    const selectValues: PrompterValue[] = ["local", "local"];
    const prompter = createFakePrompter({
      single: (opts) => {
        asked.push(opts);
        return selectValues.shift() ?? unexpectedPrompt();
      },
    }).prompter;
    const box = makeBox({
      prompter,
      targetDirectory: "/tmp/parent",
      mode: { headless: false },
      deps: fakeDeps(),
    });
    const state: SetupState = { ...stateWithAgentName("my-agent"), modelId: "openai/gpt-5.5" };

    const result = await runInteractive([box], state, silentSink);

    expect(result.kind).toBe("done");
    if (result.kind !== "done") return;
    expect(result.state.modelWiring).toBe("self");
    const credential = asked.find((opts) => /reach the model/.test(opts.message));
    const provider = credential?.options.find((option) =>
      /provider API key/.test(option.label ?? ""),
    );
    expect(provider?.hint).toBe("OPENAI_API_KEY");
  });

  it("headless: refuses --skip-vercel against a Slack selection before any effect", async () => {
    const deps = fakeDeps();
    const box = makeBox({
      prompter: createPrompter(),
      targetDirectory: "/tmp/parent",
      mode: { headless: true, project: { skipVercel: true }, aiGateway: {} },
      deps,
    });
    const state: SetupState = { ...stateWithAgentName("my-agent"), channelSelection: ["slack"] };

    await expect(runHeadless([box], state, silentSink)).rejects.toThrow(
      "Slack requires a Vercel project. Remove --skip-vercel to add Slack.",
    );
  });

  it("headless: refuses --skip-vercel against a Connect-backed connection selection", async () => {
    const deps = fakeDeps();
    const box = makeBox({
      prompter: createPrompter(),
      targetDirectory: "/tmp/parent",
      mode: { headless: true, project: { skipVercel: true }, aiGateway: {} },
      deps,
    });
    const state: SetupState = {
      ...stateWithAgentName("my-agent"),
      connectionSelection: [connectPlan("linear")],
    };

    await expect(runHeadless([box], state, silentSink)).rejects.toThrow(
      /linear authenticates through Vercel Connect.*Remove --skip-vercel/,
    );
  });

  it("propagates fail-fast through the flag-driven provisioning path", async () => {
    // Default deps: the real validateTeam reads teams through the (mocked)
    // Vercel CLI boundary and rejects on an unknown slug.
    mockedCaptureVercel.mockImplementation(async (args): Promise<VercelCaptureResult> => {
      if (args[0] === "whoami") return { ok: true, stdout: "me" };
      if (args[0] === "teams" && args[1] === "ls") {
        return {
          ok: true,
          stdout: JSON.stringify({ teams: [{ name: "Other", slug: "other", current: true }] }),
        };
      }
      return {
        ok: false,
        failure: { code: 1, stdout: "", stderr: "", message: "vercel exited with code 1." },
      };
    });
    const box = makeBox({
      prompter: createPrompter(),
      targetDirectory: "/tmp/parent",
      mode: { headless: true, project: { team: "missing" }, aiGateway: {} },
    });

    await expect(runHeadless([box], stateWithAgentName("my-agent"), silentSink)).rejects.toThrow(
      /Team "missing" was not found/,
    );
  });
});

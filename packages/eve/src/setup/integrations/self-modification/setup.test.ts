import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import type { SelfModificationSetupOperations } from "#self-modification/setup.js";
import { headlessAsker, interactiveAsker, withAnswers } from "#setup/ask.js";
import type { ProjectResolution } from "#setup/project-resolution.js";

import { integrationSetupEnvironment } from "../shared/environment.js";
import { createSetupContexts } from "../shared/ui.js";
import {
  applySelfModificationSetup,
  prepareLocalSelfModificationSetup,
  prepareSelfModificationSetup,
  SELF_MODIFICATION_PRODUCTION_SETUP,
  SELF_MODIFICATION_SETUP,
  type SelfModificationApplyDependencies,
} from "./setup.js";

function operations(config?: string): SelfModificationSetupOperations & {
  attachConnector: ReturnType<typeof vi.fn>;
  findOrCreateConnector: ReturnType<typeof vi.fn>;
  writeConfig: ReturnType<typeof vi.fn>;
} {
  return {
    attachConnector: vi.fn(async () => {}),
    detectChannelNames: vi.fn(async () => ["eve", "slack"]),
    detectGitRepository: vi.fn(async () => ({
      branch: "main",
      directory: "apps/support",
      owner: "acme",
      repo: "agents",
      remoteKind: "github" as const,
    })),
    findOrCreateConnector: vi.fn(async () => "github/selfmod-acme-agents"),
    readConfig: vi.fn(async () => config),
    writeConfig: vi.fn(async () => {}),
  };
}

function applyDependencies(): SelfModificationApplyDependencies & {
  ensureConnectionDependencies: ReturnType<typeof vi.fn>;
  installScaffoldDependencies: ReturnType<typeof vi.fn>;
} {
  return {
    ensureConnectionDependencies: vi.fn(async () => [
      {
        dependencies: ["@vercel/connect"],
        devDependencies: [],
        path: "/project/package.json",
        scripts: [],
      },
    ]),
    installScaffoldDependencies: vi.fn(async () => {}),
  };
}

function contexts(
  answers: Record<string, unknown>,
  project: ProjectResolution = { kind: "unresolved" },
) {
  const fake = createFakePrompter();
  const resolveVercelProject = vi.fn(async () => ({ orgId: "team", projectId: "project" }));
  return {
    ...createSetupContexts({
      appRoot: "/project",
      asker: withAnswers(answers)(headlessAsker()),
      environment: integrationSetupEnvironment("authenticated", project),
      prompter: fake.prompter,
      resolveVercelProject,
    }),
    note: fake.prompter.note,
    resolveVercelProject,
  };
}

describe("self-modification integration setup", () => {
  it("keeps the default setup local without mutation", async () => {
    const effects = operations();
    const ctx = contexts({});

    const plan = await prepareLocalSelfModificationSetup(ctx.prepare, effects);
    await expect(applySelfModificationSetup(plan, ctx.apply, effects)).resolves.toEqual({
      facts: [],
    });
    expect(effects.findOrCreateConnector).not.toHaveBeenCalled();
    expect(effects.writeConfig).not.toHaveBeenCalled();
  });

  it("offers deployed and local modes before collecting deployed settings", async () => {
    const effects = operations();
    const fake = createFakePrompter({
      single: (options) => {
        expect(options).toMatchObject({
          message: "How should self-modification be enabled?",
          options: [
            { value: "deployed", label: "Enable for deployed" },
            { value: "local", label: "Keep local" },
          ],
        });
        return "local";
      },
    });
    const ctx = createSetupContexts({
      appRoot: "/project",
      asker: interactiveAsker(fake.prompter),
      environment: integrationSetupEnvironment("authenticated", { kind: "unresolved" }),
      prompter: fake.prompter,
      resolveVercelProject: async () => ({ orgId: "team", projectId: "project" }),
    });

    await expect(prepareSelfModificationSetup(ctx.prepare, effects)).resolves.toEqual({
      kind: "local",
    });
    expect(effects.detectGitRepository).not.toHaveBeenCalled();
    expect(effects.detectChannelNames).not.toHaveBeenCalled();
  });

  it("prepares deployed configuration before applying connector effects", async () => {
    const effects = operations();
    const deps = applyDependencies();
    const ctx = contexts(
      {
        "self-modification-mode": "deployed",
        "self-modification-repository-owner": "acme",
        "self-modification-repository-name": "agents",
        "self-modification-repository-directory": "apps/support",
        "self-modification-target-branch": "main",
        "self-modification-confirm": true,
      },
      { kind: "linked", projectId: "project" },
    );

    const plan = await prepareSelfModificationSetup(ctx.prepare, effects);
    expect(effects.findOrCreateConnector).not.toHaveBeenCalled();
    await expect(applySelfModificationSetup(plan, ctx.apply, effects, deps)).resolves.toMatchObject(
      {
        deploymentRequired: true,
      },
    );
    expect(ctx.resolveVercelProject).toHaveBeenCalledWith("self-modification");
    expect(effects.findOrCreateConnector).toHaveBeenCalledWith("selfmod-acme-agents", {
      orgId: "team",
      projectId: "project",
    });
    expect(effects.attachConnector).toHaveBeenCalledWith("github/selfmod-acme-agents", {
      orgId: "team",
      projectId: "project",
    });
    expect(deps.ensureConnectionDependencies).toHaveBeenCalledWith({ projectRoot: "/project" });
    expect(deps.installScaffoldDependencies).toHaveBeenCalledWith(
      expect.objectContaining({ changed: true, projectPath: "/project" }),
    );
    expect(effects.writeConfig).toHaveBeenCalledWith(
      expect.stringContaining('repository: "github.com/acme/agents"'),
    );
    expect(effects.writeConfig).toHaveBeenCalledWith(
      expect.stringContaining('case "channel:slack"'),
    );
    expect(effects.writeConfig).toHaveBeenCalledWith(expect.stringContaining('case "http"'));
    expect(effects.writeConfig).toHaveBeenCalledWith(
      expect.stringContaining('import { getToken } from "@vercel/connect"'),
    );
    expect(effects.writeConfig).toHaveBeenCalledWith(
      expect.stringContaining("async resolve({ capability, repository })"),
    );
    expect(ctx.note).toHaveBeenCalledWith(
      expect.stringContaining(
        "After deployment, try self-modification by running `eve dev <deployment-url>`",
      ),
      "Next steps",
      { tone: "success" },
    );
  });

  it("resolves a Vercel project before configuring deployed self-modification", async () => {
    const effects = operations();
    const ctx = contexts({
      "self-modification-mode": "deployed",
      "self-modification-repository-owner": "acme",
      "self-modification-repository-name": "agents",
      "self-modification-repository-directory": "apps/support",
      "self-modification-target-branch": "main",
      "self-modification-confirm": true,
    });

    const plan = await prepareSelfModificationSetup(ctx.prepare, effects);
    await applySelfModificationSetup(plan, ctx.apply, effects);

    expect(ctx.resolveVercelProject).toHaveBeenCalledWith("self-modification");
    expect(effects.writeConfig).toHaveBeenCalledWith(expect.stringContaining('case "http"'));
  });

  it("registers the production setup separately from local setup", () => {
    expect(SELF_MODIFICATION_PRODUCTION_SETUP.kind).toBe("self-modification-production");
  });

  it("describes unavailable Vercel setup without suggesting portable credentials", () => {
    const environment = integrationSetupEnvironment("cli-missing", { kind: "unresolved" });
    expect(SELF_MODIFICATION_SETUP.describeEnvironment?.(environment)).toBe(
      "Vercel CLI not found. Local editing remains available; deployed proposals require Vercel Connect.",
    );
  });
});

import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import type {
  BranchProtectionStatus,
  SelfModificationSetupOperations,
} from "#self-modification/setup.js";
import { headlessAsker, interactiveAsker, withAnswers } from "#setup/ask.js";
import type { ProjectResolution } from "#setup/project-resolution.js";

import { integrationSetupEnvironment } from "../shared/environment.js";
import { createSetupContexts } from "../shared/ui.js";
import {
  applySelfModificationSetup,
  prepareLocalSelfModificationSetup,
  prepareSelfModificationSetup,
  SELF_MODIFICATION_SETUP,
} from "./setup.js";

function operations(
  config?: string,
  branchProtection: BranchProtectionStatus = "pull-request-required",
): SelfModificationSetupOperations & {
  attachConnector: ReturnType<typeof vi.fn>;
  checkBranchProtection: ReturnType<typeof vi.fn>;
  findOrCreateConnector: ReturnType<typeof vi.fn>;
  writeConfig: ReturnType<typeof vi.fn>;
} {
  return {
    attachConnector: vi.fn(async () => {}),
    checkBranchProtection: vi.fn(async () => branchProtection),
    detectChannelNames: vi.fn(async () => ["slack"]),
    detectGitRepository: vi.fn(async () => ({
      branch: "main",
      directory: "apps/support",
      owner: "acme",
      repo: "agents",
      remoteKind: "github" as const,
    })),
    findOrCreateConnector: vi.fn(async () => "github/selfmod-acme-agents"),
    readConfig: vi.fn(async () => config),
    readLocalConfig: vi.fn(async () => config),
    writeConfig: vi.fn(async () => {}),
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
    note: vi.mocked(fake.prompter.note),
    resolveVercelProject,
  };
}

const deployedAnswers = {
  "self-modification-mode": "deployed",
  "self-modification-repository-owner": "acme",
  "self-modification-repository-name": "agents",
  "self-modification-repository-directory": "apps/support",
  "self-modification-target-branch": "main",
  "self-modification-confirm": true,
};

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
  });

  it("prepares deployed configuration before applying connector effects", async () => {
    const effects = operations();
    const ctx = contexts(deployedAnswers, { kind: "linked", projectId: "project" });

    const plan = await prepareSelfModificationSetup(ctx.prepare, effects);
    expect(effects.findOrCreateConnector).not.toHaveBeenCalled();
    expect(effects.checkBranchProtection).toHaveBeenCalledWith("acme/agents", "main");
    expect(ctx.note).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      tone: "warning",
    });
    await expect(applySelfModificationSetup(plan, ctx.apply, effects)).resolves.toMatchObject({
      deploymentRequired: true,
      facts: expect.arrayContaining([
        { label: "Branch protection", value: "pull requests required" },
      ]),
    });
    expect(ctx.resolveVercelProject).toHaveBeenCalledWith("self-modification");
    expect(effects.findOrCreateConnector).toHaveBeenCalledWith("selfmod-acme-agents", {
      orgId: "team",
      projectId: "project",
    });
    expect(effects.attachConnector).toHaveBeenCalledWith("github/selfmod-acme-agents", {
      orgId: "team",
      projectId: "project",
    });
    expect(effects.writeConfig).toHaveBeenCalledWith(
      expect.stringContaining('import selfModification from "eve/self-modification/remote"'),
    );
    const configured = effects.writeConfig.mock.calls[0]?.[0] as string;
    expect(configured).toContain('repository: "acme/agents"');
    expect(configured).toContain('case "http"');
    expect(configured).toContain('case "channel:slack"');
    expect(configured).not.toContain("authorize: () => true");
    const nextSteps = ctx.note.mock.calls.find(([, title]) => title === "Next steps")?.[0];
    expect(nextSteps).toContain("The generated policy admits its Vercel OIDC identity over HTTP");
    expect(nextSteps).not.toContain("ruleset");
  });

  it.each([
    [
      "unprotected",
      "Protect main before deploying (strongly recommended)",
      "has no branch protection",
    ],
    ["unknown", "Protect main before deploying (strongly recommended)", "`gh auth login`"],
    ["protected", "Confirm that main requires pull requests", "only repository administrators"],
  ] as const)(
    "strongly recommends a pull request ruleset when the base branch is %s",
    async (status, title, detail) => {
      const effects = operations(undefined, status);
      const ctx = contexts(deployedAnswers);

      const plan = await prepareSelfModificationSetup(ctx.prepare, effects);
      const warning = ctx.note.mock.calls.find(([, t]) => t === title);
      expect(warning?.[2]).toEqual({ tone: "warning" });
      expect(warning?.[0]).toContain(detail);
      expect(warning?.[0]).toContain(
        "does not list the Vercel Connect GitHub App as a bypass actor",
      );
      const result = await applySelfModificationSetup(plan, ctx.apply, effects);
      expect(result.facts).toContainEqual({
        label: "Branch protection",
        value: expect.stringContaining(status === "protected" ? "not verified" : "strongly"),
      });
      const nextSteps = ctx.note.mock.calls.find(([, t]) => t === "Next steps")?.[0];
      expect(nextSteps).toContain("Strongly recommended: Add a repository ruleset");
    },
  );

  it("resolves a Vercel project before configuring deployed self-modification", async () => {
    const effects = operations();
    const ctx = contexts(deployedAnswers);

    const plan = await prepareSelfModificationSetup(ctx.prepare, effects);
    await applySelfModificationSetup(plan, ctx.apply, effects);

    expect(ctx.resolveVercelProject).toHaveBeenCalledWith("self-modification");
    expect(effects.writeConfig).toHaveBeenCalledWith(
      expect.stringContaining('connector: "github/selfmod-acme-agents"'),
    );
  });

  it("describes unavailable Vercel setup without suggesting portable credentials", () => {
    const environment = integrationSetupEnvironment("cli-missing", { kind: "unresolved" });
    expect(SELF_MODIFICATION_SETUP.describeEnvironment?.(environment)).toBe(
      "Vercel CLI not found. Local editing remains available; deployed proposals require Vercel Connect.",
    );
  });
});

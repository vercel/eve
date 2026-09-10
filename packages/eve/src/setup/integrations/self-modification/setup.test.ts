import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import type { SelfModificationSetupOperations } from "#self-modification/setup.js";
import { headlessAsker, withAnswers } from "#setup/ask.js";
import type { ProjectResolution } from "#setup/project-resolution.js";

import { integrationSetupEnvironment } from "../shared/environment.js";
import { createSetupContexts } from "../shared/ui.js";
import {
  applySelfModificationSetup,
  prepareLocalSelfModificationSetup,
  prepareSelfModificationSetup,
  SELF_MODIFICATION_PRODUCTION_SETUP,
  SELF_MODIFICATION_SETUP,
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

function contexts(
  answers: Record<string, unknown>,
  project: ProjectResolution = { kind: "unresolved" },
) {
  const fake = createFakePrompter();
  return {
    ...createSetupContexts({
      appRoot: "/project",
      asker: withAnswers(answers)(headlessAsker()),
      environment: integrationSetupEnvironment("authenticated", project),
      prompter: fake.prompter,
      resolveVercelProject: async () => ({ orgId: "team", projectId: "project" }),
    }),
    note: fake.prompter.note,
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

  it("prepares deployed configuration before applying connector effects", async () => {
    const effects = operations();
    const ctx = contexts(
      {
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
    await expect(applySelfModificationSetup(plan, ctx.apply, effects)).resolves.toMatchObject({
      deploymentRequired: true,
    });
    expect(effects.attachConnector).toHaveBeenCalledWith("github/selfmod-acme-agents");
    expect(effects.writeConfig).toHaveBeenCalledWith(
      expect.stringContaining('repository: "github.com/acme/agents"'),
    );
    expect(effects.writeConfig).toHaveBeenCalledWith(
      expect.stringContaining('case "channel:slack"'),
    );
    expect(effects.writeConfig).toHaveBeenCalledWith(expect.stringContaining('case "http"'));
    expect(ctx.note).toHaveBeenCalledWith(
      expect.stringContaining(
        "After deployment, try self-modification by running `eve dev <deployment-url>`",
      ),
      "Next steps",
      { tone: "success" },
    );
  });

  it("omits Vercel authorization when no Vercel backend is configured", async () => {
    const effects = operations();
    const ctx = contexts({
      "self-modification-repository-owner": "acme",
      "self-modification-repository-name": "agents",
      "self-modification-repository-directory": "apps/support",
      "self-modification-target-branch": "main",
      "self-modification-confirm": true,
    });

    const plan = await prepareSelfModificationSetup(ctx.prepare, effects);
    await applySelfModificationSetup(plan, ctx.apply, effects);

    expect(effects.writeConfig).toHaveBeenCalledWith(expect.not.stringContaining('case "http"'));
    expect(effects.writeConfig).toHaveBeenCalledWith(
      expect.stringContaining(
        "switch (channel.kind) {\n        default:\n          // Add another branch when you add a trusted channel.",
      ),
    );
    expect(ctx.note).toHaveBeenCalledWith(
      expect.stringContaining("configure `deployed.authorize`"),
      "Next steps",
      { tone: "success" },
    );
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

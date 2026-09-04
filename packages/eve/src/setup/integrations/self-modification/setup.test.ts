import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import type { SelfModificationSetupOperations } from "#self-modification/setup.js";
import { headlessAsker, withAnswers } from "#setup/ask.js";

import { integrationSetupEnvironment } from "../shared/environment.js";
import { createSetupContexts } from "../shared/ui.js";
import {
  applySelfModificationSetup,
  prepareSelfModificationSetup,
  SELF_MODIFICATION_SETUP,
} from "./setup.js";

function operations(config?: string): SelfModificationSetupOperations & {
  attachConnector: ReturnType<typeof vi.fn>;
  findOrCreateConnector: ReturnType<typeof vi.fn>;
  writeConfig: ReturnType<typeof vi.fn>;
} {
  return {
    attachConnector: vi.fn(async () => {}),
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

function contexts(answers: Record<string, unknown>) {
  return createSetupContexts({
    appRoot: "/project",
    asker: withAnswers(answers)(headlessAsker()),
    environment: integrationSetupEnvironment("authenticated", { kind: "unresolved" }),
    prompter: createFakePrompter().prompter,
    resolveVercelProject: async () => ({ orgId: "team", projectId: "project" }),
  });
}

describe("self-modification integration setup", () => {
  it("keeps the default setup local without mutation", async () => {
    const effects = operations();
    const ctx = contexts({ "self-modification-deployed": false });

    const plan = await prepareSelfModificationSetup(ctx.prepare, effects);
    await expect(applySelfModificationSetup(plan, ctx.apply, effects)).resolves.toEqual({
      facts: [{ label: "Self-modification", value: "local editing" }],
    });
    expect(effects.findOrCreateConnector).not.toHaveBeenCalled();
    expect(effects.writeConfig).not.toHaveBeenCalled();
  });

  it("prepares deployed configuration before applying connector effects", async () => {
    const effects = operations();
    const ctx = contexts({
      "self-modification-deployed": true,
      "self-modification-repository-owner": "acme",
      "self-modification-repository-name": "agents",
      "self-modification-repository-directory": "apps/support",
      "self-modification-target-branch": "main",
      "self-modification-confirm": true,
    });

    const plan = await prepareSelfModificationSetup(ctx.prepare, effects);
    expect(effects.findOrCreateConnector).not.toHaveBeenCalled();
    await expect(applySelfModificationSetup(plan, ctx.apply, effects)).resolves.toMatchObject({
      deploymentRequired: true,
    });
    expect(effects.attachConnector).toHaveBeenCalledWith("github/selfmod-acme-agents");
    expect(effects.writeConfig).toHaveBeenCalledWith(
      expect.stringContaining('repository: "github.com/acme/agents"'),
    );
  });

  it("describes unavailable Vercel setup without suggesting portable credentials", () => {
    const environment = integrationSetupEnvironment("cli-missing", { kind: "unresolved" });
    expect(SELF_MODIFICATION_SETUP.describeEnvironment?.(environment)).toBe(
      "Vercel CLI not found. Local editing remains available; deployed proposals require Vercel Connect.",
    );
  });
});

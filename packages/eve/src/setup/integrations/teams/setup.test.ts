import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { headlessAsker, withAnswers } from "#setup/ask.js";
import { integrationSetupEnvironment } from "../shared/environment.js";
import { createSetupContexts } from "../shared/ui.js";
import { applyTeamsSetup, prepareTeamsSetup, type TeamsSetupDeps } from "./setup.js";

function deps(): TeamsSetupDeps {
  return {
    attachTrigger: vi.fn(async () => {}),
    createConnector: vi.fn(async () => ({ connectorId: "scl_teams", url: "https://login.test" })),
    readConnector: vi.fn(async () => ({ id: "scl_teams", uid: "microsoft-teams/agent" })),
    openUrl: vi.fn(),
    runVercel: vi.fn(),
    runVercelCaptureStdout: vi.fn(),
    writeTextFile: vi.fn(async () => {}),
  };
}

function contexts(answers: Record<string, unknown>) {
  return createSetupContexts({
    appRoot: "/project",
    asker: withAnswers(answers)(headlessAsker()),
    environment: integrationSetupEnvironment("authenticated", { kind: "unresolved" }),
    prompter: createFakePrompter().prompter,
    resolveVercelProject: vi.fn(async () => ({ orgId: "team", projectId: "project" })),
  });
}

describe("Microsoft Teams setup", () => {
  it("creates the managed bot, waits for browser authorization, and scaffolds the channel", async () => {
    const effects = deps();
    const ctx = contexts({
      "teams.bot-name": " Agent ",
      "teams.azure-subscription-id": " subscription ",
      "teams.azure-resource-group": " bots ",
      "teams.creation-complete": true,
    });

    const plan = await prepareTeamsSetup(ctx.prepare);
    expect(effects.createConnector).not.toHaveBeenCalled();
    await expect(applyTeamsSetup(plan, ctx.apply, effects)).resolves.toMatchObject({
      deploymentRequired: true,
    });

    expect(effects.createConnector).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Agent",
        resourceGroup: "bots",
        subscriptionId: "subscription",
      }),
    );
    expect(effects.openUrl).toHaveBeenCalledWith("https://login.test");
    expect(effects.attachTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ connector: { id: "scl_teams", uid: "microsoft-teams/agent" } }),
    );
    expect(effects.writeTextFile).toHaveBeenCalledWith(
      "/project/agent/channels/teams.ts",
      expect.stringContaining('connectTeamsCredentials("microsoft-teams/agent")'),
      { force: undefined },
    );
  });
});

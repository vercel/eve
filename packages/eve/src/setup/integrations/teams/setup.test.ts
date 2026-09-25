import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { headlessAsker, withAnswers } from "#setup/ask.js";
import { integrationSetupEnvironment } from "../shared/environment.js";
import { createSetupContexts } from "../shared/ui.js";
import { applyTeamsSetup, prepareTeamsSetup, type TeamsSetupDeps } from "./setup.js";

function deps(): TeamsSetupDeps {
  return {
    provisionConnector: vi.fn(async () => ({
      id: "scl_teams",
      uid: "microsoft-teams/agent",
    })),
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
  it("delegates setup to the Connect CLI and scaffolds its connector", async () => {
    const effects = deps();
    const ctx = contexts({ "teams.bot-name": " Agent " });

    const plan = await prepareTeamsSetup(ctx.prepare);
    expect(effects.provisionConnector).not.toHaveBeenCalled();
    await expect(applyTeamsSetup(plan, ctx.apply, effects)).resolves.toMatchObject({
      deploymentRequired: true,
    });

    expect(effects.provisionConnector).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Agent",
        project: { orgId: "team", projectId: "project" },
      }),
    );
    expect(effects.writeTextFile).toHaveBeenCalledWith(
      "/project/agent/channels/teams.ts",
      expect.stringContaining('connectTeamsCredentials("microsoft-teams/agent")'),
      { force: undefined },
    );
  });
});

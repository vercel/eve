import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { headlessAsker, withAnswers } from "#setup/ask.js";

import { integrationSetupEnvironment } from "../shared/environment.js";
import { createSetupContexts } from "../shared/ui.js";
import { applySendblueSetup, prepareSendblueSetup, type SendblueSetupDeps } from "./setup.js";

const PORTABLE_ANSWERS = {
  "sendblue-credentials": "portable",
  "sendblue-api-key": "api-key",
  "sendblue-api-secret": "api-secret",
  "sendblue-from-number": "+15551234567",
};

function deps(): SendblueSetupDeps {
  return {
    appendEnv: vi.fn(async () => ({ written: [], skipped: [] })),
    deriveConnectorSlug: vi.fn(async () => "agent" as never),
    provisionConnector: vi.fn(async () => ({
      id: "connector",
      uid: "sendblue/agent",
    })),
    writeTextFile: vi.fn(async () => {}),
  };
}

function contexts(
  answers: Record<string, unknown>,
  auth: "authenticated" | "cli-missing" = "authenticated",
  resolveVercelProject = vi.fn(async () => ({ orgId: "team", projectId: "project" })),
) {
  return createSetupContexts({
    appRoot: "/project",
    asker: withAnswers(answers)(headlessAsker()),
    environment: integrationSetupEnvironment(auth, { kind: "unresolved" }),
    prompter: createFakePrompter().prompter,
    resolveVercelProject,
  });
}

describe("Sendblue setup", () => {
  it("collects portable credentials before mutation", async () => {
    const effects = deps();
    await expect(
      prepareSendblueSetup(contexts({ "sendblue-credentials": "portable" }).prepare),
    ).rejects.toThrow("SENDBLUE_API_KEY");
    expect(effects.provisionConnector).not.toHaveBeenCalled();
    expect(effects.writeTextFile).not.toHaveBeenCalled();
  });

  it("applies a portable plan", async () => {
    const effects = deps();
    const ctx = contexts(PORTABLE_ANSWERS, "cli-missing");
    const plan = await prepareSendblueSetup(ctx.prepare);
    await applySendblueSetup(plan, ctx.apply, effects);

    expect(effects.appendEnv).toHaveBeenCalledWith("/project/.env.local", {
      SENDBLUE_API_KEY: "api-key",
      SENDBLUE_API_SECRET: "api-secret",
      SENDBLUE_FROM_NUMBER: "+15551234567",
    });
  });

  it("requires a linked project for Connect without asking for Sendblue credentials", async () => {
    const effects = deps();
    const resolveVercelProject = vi.fn(async () => {
      throw new Error("eve link");
    });
    await expect(
      prepareSendblueSetup(
        contexts({ "sendblue-credentials": "vercel" }, "authenticated", resolveVercelProject)
          .prepare,
      ),
    ).rejects.toThrow("eve link");
    expect(effects.provisionConnector).not.toHaveBeenCalled();
  });

  it("scaffolds the managed Connect account and provisioned line", async () => {
    const effects = deps();
    const ctx = contexts({ "sendblue-credentials": "vercel" });
    const plan = await prepareSendblueSetup(ctx.prepare);
    await applySendblueSetup(plan, ctx.apply, effects);

    expect(effects.provisionConnector).toHaveBeenCalledWith(
      expect.objectContaining({
        project: { orgId: "team", projectId: "project" },
        slug: "agent",
      }),
    );
    expect(effects.writeTextFile).toHaveBeenCalledWith(
      "/project/agent/channels/sendblue.ts",
      expect.stringContaining('connectSendblueChannel("sendblue/agent")'),
      { force: undefined },
    );
  });
});

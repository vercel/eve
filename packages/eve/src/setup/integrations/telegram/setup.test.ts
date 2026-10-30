import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { headlessAsker, withAnswers, withPolicy } from "#setup/ask.js";

vi.mock("#setup/scaffold/index.js", () => ({
  deriveSlackConnectorSlug: vi.fn(async () => "agent"),
}));

import { prepareTelegramSetup, type TelegramSetupDeps } from "./setup.js";
import { integrationSetupEnvironment } from "../shared/environment.js";
import { createSetupContexts } from "../shared/ui.js";

function deps(): TelegramSetupDeps {
  return { fetchBotUsername: vi.fn(async () => "my_bot") };
}

function contexts(answers: Record<string, unknown> = {}) {
  return createSetupContexts({
    appRoot: "/project",
    asker: withAnswers(answers)(withPolicy("assume")(headlessAsker())),
    environment: integrationSetupEnvironment("authenticated", { kind: "unresolved" }),
    prompter: createFakePrompter().prompter,
    resolveVercelProject: vi.fn(async () => ({ orgId: "team", projectId: "project" })),
  });
}

describe("Telegram setup", () => {
  it("prepares Connect credentials by default and validates the token", async () => {
    const setupDeps = deps();
    await expect(
      prepareTelegramSetup(contexts({ "telegram-bot-token": " 123456:token " }).prepare, setupDeps),
    ).resolves.toEqual({
      credentials: "connect",
      botToken: "123456:token",
      botUsername: "my_bot",
      connectorSlug: "agent",
      project: { orgId: "team", projectId: "project" },
    });
    expect(setupDeps.fetchBotUsername).toHaveBeenCalledWith("123456:token", undefined);
  });

  it("skips the Vercel project for portable credentials", async () => {
    await expect(
      prepareTelegramSetup(
        contexts({
          "telegram-credentials": "portable",
          "telegram-bot-token": "123456:token",
        }).prepare,
        deps(),
      ),
    ).resolves.toEqual({
      credentials: "portable",
      botToken: "123456:token",
      botUsername: "my_bot",
    });
  });
});

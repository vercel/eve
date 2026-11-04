import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { headlessAsker, withAnswers, withPolicy } from "#setup/ask.js";
import { WriteFileExistsError } from "#setup/scaffold/files.js";

vi.mock("#setup/scaffold/index.js", () => ({
  deriveSlackConnectorSlug: vi.fn(async () => "agent"),
}));

import { prepareTelegramSetup, type TelegramSetupDeps } from "./setup.js";
import { integrationSetupEnvironment } from "../shared/environment.js";
import { createSetupContexts } from "../shared/ui.js";

function deps(overrides: Partial<TelegramSetupDeps> = {}): TelegramSetupDeps {
  return {
    fetchBotUsername: vi.fn(async () => "my_bot"),
    pathExists: vi.fn(async () => false),
    readEnvFile: vi.fn(async () => undefined),
    ...overrides,
  };
}

function contexts(answers: Record<string, unknown> = {}, force = false) {
  return createSetupContexts({
    appRoot: "/project",
    asker: withAnswers(answers)(withPolicy("assume")(headlessAsker())),
    environment: integrationSetupEnvironment("authenticated", { kind: "unresolved" }),
    prompter: createFakePrompter().prompter,
    resolveVercelProject: vi.fn(async () => ({ orgId: "team", projectId: "project" })),
    force,
  });
}

const portable = { "telegram-credentials": "portable", "telegram-bot-token": "123456:token" };

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

  it("refuses an existing channel file before asking anything", async () => {
    const setupDeps = deps({ pathExists: vi.fn(async () => true) });
    await expect(prepareTelegramSetup(contexts().prepare, setupDeps)).rejects.toBeInstanceOf(
      WriteFileExistsError,
    );
    expect(setupDeps.fetchBotUsername).not.toHaveBeenCalled();
  });

  it("allows an existing channel file with --force", async () => {
    const setupDeps = deps({ pathExists: vi.fn(async () => true) });
    await expect(
      prepareTelegramSetup(contexts(portable, true).prepare, setupDeps),
    ).resolves.toMatchObject({ credentials: "portable" });
  });

  it("skips the Vercel project for portable credentials", async () => {
    await expect(prepareTelegramSetup(contexts(portable).prepare, deps())).resolves.toEqual({
      credentials: "portable",
      botToken: "123456:token",
      botUsername: "my_bot",
      replaceBotToken: false,
    });
  });

  it("keeps a matching TELEGRAM_BOT_TOKEN without asking", async () => {
    const setupDeps = deps({ readEnvFile: vi.fn(async () => "TELEGRAM_BOT_TOKEN=123456:token\n") });
    await expect(
      prepareTelegramSetup(contexts(portable).prepare, setupDeps),
    ).resolves.toMatchObject({ replaceBotToken: false });
  });

  it("replaces a different TELEGRAM_BOT_TOKEN only after confirmation", async () => {
    const setupDeps = deps({ readEnvFile: vi.fn(async () => "TELEGRAM_BOT_TOKEN=999:old\n") });
    await expect(
      prepareTelegramSetup(
        contexts({ ...portable, "telegram-replace-bot-token": true }).prepare,
        setupDeps,
      ),
    ).resolves.toMatchObject({ replaceBotToken: true });
    await expect(
      prepareTelegramSetup(
        contexts({ ...portable, "telegram-replace-bot-token": false }).prepare,
        setupDeps,
      ),
    ).rejects.toThrow("keeps its existing TELEGRAM_BOT_TOKEN");
  });
});

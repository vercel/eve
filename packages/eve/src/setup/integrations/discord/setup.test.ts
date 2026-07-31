import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import type { Asker, Question } from "#setup/ask.js";
import { integrationSetupEnvironment } from "../shared/environment.js";
import { createIntegrationSetupUi } from "../shared/ui.js";
import { setupDiscord, type DiscordSetupDeps } from "./setup.js";

function asker(answers: Record<string, string>): Asker {
  return {
    ask: async <T>(question: Question<T>) => answers[question.key] as T,
    askMany: async () => [],
  };
}

function deps(): DiscordSetupDeps {
  return {
    configureEndpoint: vi.fn(async () => {}),
    deriveConnectorSlug: vi.fn(async () => "agent" as never),
    ensureVercelProject: vi.fn(async () => ({ orgId: "team-id", projectId: "project-id" })),
    provisionConnector: vi.fn(async () => ({ id: "scl_discord", uid: "discord/agent" })),
    registerCommand: vi.fn(async () => {}),
    resolveApplication: vi.fn(async () => ({
      id: "app-1",
      name: "Agent",
      publicKey: "public-key",
    })),
    writeTextFile: vi.fn(async () => {}),
  };
}

describe("Discord setup", () => {
  it("provisions Connect, registers the command and callback, and scaffolds the channel", async () => {
    const fake = createFakePrompter();
    const effects = deps();

    await expect(
      setupDiscord(
        {
          appRoot: "/project",
          environment: integrationSetupEnvironment("authenticated", { kind: "unresolved" }),
          ui: createIntegrationSetupUi({
            asker: asker({
              "discord-bot-token": "bot-token",
              "discord-command-name": "ask",
              "discord-command-description": "Ask the eve agent",
            }),
            prompter: fake.prompter,
          }),
        },
        effects,
      ),
    ).resolves.toMatchObject({ kind: "done" });

    expect(effects.registerCommand).toHaveBeenCalledWith("app-1", "bot-token", {
      name: "ask",
      description: "Ask the eve agent",
    });
    expect(effects.configureEndpoint).toHaveBeenCalledWith("bot-token", "scl_discord");
    expect(effects.writeTextFile).toHaveBeenCalledWith(
      "/project/agent/channels/discord.ts",
      expect.stringContaining('connectDiscordCredentials("discord/agent")'),
      { force: undefined },
    );
  });

  it("requires an authenticated Vercel CLI", async () => {
    const fake = createFakePrompter();
    await expect(
      setupDiscord({
        appRoot: "/project",
        environment: integrationSetupEnvironment("logged-out", { kind: "unresolved" }),
        ui: createIntegrationSetupUi({ asker: asker({}), prompter: fake.prompter }),
      }),
    ).rejects.toThrow("vercel login");
  });
});

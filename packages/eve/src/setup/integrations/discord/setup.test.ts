import { describe, expect, it, vi } from "vitest";
import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { headlessAsker, withAnswers } from "#setup/ask.js";
import { integrationSetupEnvironment } from "../shared/environment.js";
import { createSetupContexts } from "../shared/ui.js";
import { applyDiscordSetup, prepareDiscordSetup, type DiscordSetupDeps } from "./setup.js";

const ANSWERS = {
  "discord-bot-token": " bot-token ",
  "discord-command-name": "ask",
  "discord-command-description": "Ask the eve agent",
};
function deps(): DiscordSetupDeps {
  return {
    configureEndpoint: vi.fn(async () => {}),
    deriveConnectorSlug: vi.fn(async () => "agent" as never),
    readProjectLink: vi.fn(async () => ({ orgId: "team", projectId: "project" })),
    provisionConnector: vi.fn(async () => ({ id: "connector", uid: "discord/agent" })),
    registerCommand: vi.fn(async () => {}),
    resolveApplication: vi.fn(async () => ({ id: "app", name: "Agent", publicKey: "key" })),
    writeTextFile: vi.fn(async () => {}),
  };
}
function contexts(answers: Record<string, unknown>) {
  return createSetupContexts({
    appRoot: "/project",
    asker: withAnswers(answers)(headlessAsker()),
    environment: integrationSetupEnvironment("authenticated", { kind: "unresolved" }),
    prompter: createFakePrompter().prompter,
  });
}

describe("Discord setup", () => {
  it("prepares all input before applying", async () => {
    const effects = deps();
    const ctx = contexts(ANSWERS);
    const plan = await prepareDiscordSetup(ctx.prepare, effects);
    expect(effects.resolveApplication).not.toHaveBeenCalled();
    await applyDiscordSetup(plan, ctx.apply, effects);
    expect(effects.resolveApplication).toHaveBeenCalledWith("bot-token");
    expect(effects.writeTextFile).toHaveBeenCalledWith(
      "/project/agent/channels/discord.ts",
      expect.stringContaining("discord/agent"),
      { force: undefined },
    );
  });
  it("refuses missing input before mutation", async () => {
    const effects = deps();
    await expect(prepareDiscordSetup(contexts({}).prepare, effects)).rejects.toMatchObject({
      prerequisite: { kind: "environment", variable: "DISCORD_BOT_TOKEN" },
    });
    expect(effects.resolveApplication).not.toHaveBeenCalled();
  });
  it("requires a linked project", async () => {
    const effects = deps();
    vi.mocked(effects.readProjectLink).mockResolvedValue(undefined);
    await expect(prepareDiscordSetup(contexts(ANSWERS).prepare, effects)).rejects.toThrow(
      "eve link",
    );
    expect(effects.provisionConnector).not.toHaveBeenCalled();
  });
});

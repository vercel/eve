import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import {
  headlessAsker,
  InteractionRequired,
  withAnswers,
  type Asker,
  type Question,
} from "#setup/ask.js";
import { HumanActionRequiredError } from "#setup/human-action.js";
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

const DISCORD_ANSWERS = {
  "discord-bot-token": "  bot-token  ",
  "discord-command-name": "ask",
  "discord-command-description": "Ask the eve agent",
} as const;

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
            asker: asker({ ...DISCORD_ANSWERS }),
            prompter: fake.prompter,
          }),
        },
        effects,
      ),
    ).resolves.toMatchObject({ kind: "done" });

    expect(effects.resolveApplication).toHaveBeenCalledWith("bot-token");
    expect(effects.provisionConnector).toHaveBeenCalledWith(
      expect.objectContaining({ botToken: "bot-token" }),
    );
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

  it("prefills the command name and description", async () => {
    const questions: Question<unknown>[] = [];
    const effects = deps();
    await setupDiscord(
      {
        appRoot: "/project",
        environment: integrationSetupEnvironment("authenticated", { kind: "unresolved" }),
        ui: createIntegrationSetupUi({
          asker: {
            ask: async <T>(question: Question<T>) => {
              questions.push(question as Question<unknown>);
              if (question.key === "discord-bot-token") return "bot-token" as T;
              return question.detected as T;
            },
            askMany: async () => [],
          },
          prompter: createFakePrompter().prompter,
        }),
      },
      effects,
    );

    expect(questions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "discord-command-name", detected: "ask" }),
        expect.objectContaining({
          key: "discord-command-description",
          detected: "Ask the eve agent",
        }),
      ]),
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

  it("headless answers-by-key succeeds without prompting and passes headless to ensureVercelProject", async () => {
    const fake = createFakePrompter();
    const effects = deps();
    const headless = withAnswers({ ...DISCORD_ANSWERS })(headlessAsker());

    await expect(
      setupDiscord(
        {
          appRoot: "/project",
          environment: integrationSetupEnvironment("authenticated", {
            kind: "linked",
            projectId: "project-id",
          }),
          headless: true,
          ui: createIntegrationSetupUi({ asker: headless, prompter: fake.prompter }),
        },
        effects,
      ),
    ).resolves.toMatchObject({ kind: "done" });

    expect(effects.ensureVercelProject).toHaveBeenCalledWith(
      expect.objectContaining({ headless: true }),
    );
    expect(fake.selectMessages).toEqual([]);
  });

  it("missing required answer throws InteractionRequired before any mutation", async () => {
    const fake = createFakePrompter();
    const effects = deps();
    const headless = withAnswers({})(headlessAsker());

    await expect(
      setupDiscord(
        {
          appRoot: "/project",
          environment: integrationSetupEnvironment("authenticated", {
            kind: "linked",
            projectId: "project-id",
          }),
          headless: true,
          ui: createIntegrationSetupUi({ asker: headless, prompter: fake.prompter }),
        },
        effects,
      ),
    ).rejects.toBeInstanceOf(InteractionRequired);

    expect(effects.resolveApplication).not.toHaveBeenCalled();
    expect(effects.ensureVercelProject).not.toHaveBeenCalled();
    expect(effects.provisionConnector).not.toHaveBeenCalled();
    expect(effects.registerCommand).not.toHaveBeenCalled();
    expect(effects.configureEndpoint).not.toHaveBeenCalled();
    expect(effects.writeTextFile).not.toHaveBeenCalled();
  });

  it("propagates ensureVercelProject headless failure without Connect mutation", async () => {
    const fake = createFakePrompter();
    const effects = deps();
    effects.ensureVercelProject = vi.fn(async () => {
      throw new HumanActionRequiredError({
        kind: "vercel-link",
        command: "vercel link",
        reason:
          "Integration setup needs this directory linked to a Vercel project before continuing.",
      });
    });
    const headless = withAnswers({ ...DISCORD_ANSWERS })(headlessAsker());

    await expect(
      setupDiscord(
        {
          appRoot: "/project",
          environment: integrationSetupEnvironment("authenticated", { kind: "unresolved" }),
          headless: true,
          ui: createIntegrationSetupUi({ asker: headless, prompter: fake.prompter }),
        },
        effects,
      ),
    ).rejects.toBeInstanceOf(HumanActionRequiredError);

    expect(effects.resolveApplication).toHaveBeenCalled();
    expect(effects.provisionConnector).not.toHaveBeenCalled();
    expect(effects.writeTextFile).not.toHaveBeenCalled();
  });
});

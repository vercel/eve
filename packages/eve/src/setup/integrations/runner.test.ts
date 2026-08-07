import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import {
  headlessAsker,
  InteractionRequired,
  withAnswers,
  type Asker,
  type Question,
} from "#setup/ask.js";

import { composeIntegrationAsker, runIntegrationSetup } from "./runner.js";
import { createIntegrationSetupUi } from "./shared/ui.js";
import { integrationSetupEnvironment } from "./shared/environment.js";

vi.mock("./registry.js", () => ({
  setupIntegration: vi.fn(),
}));

import { setupIntegration } from "./registry.js";

describe("composeIntegrationAsker", () => {
  it("uses interactiveAsker by default so prompts reach the prompter", async () => {
    const fake = createFakePrompter({
      password: () => "secret-token",
    });
    const asker = composeIntegrationAsker({ prompter: fake.prompter });
    await expect(
      asker.ask({
        key: "discord-bot-token",
        kind: "text",
        message: "Discord bot token",
        required: true,
        sensitive: true,
      }),
    ).resolves.toBe("secret-token");
  });

  it("headless with answers resolves by key without touching the prompter", async () => {
    const fake = createFakePrompter();
    const asker = composeIntegrationAsker({
      prompter: fake.prompter,
      headless: true,
      answers: { "discord-bot-token": "from-agent" },
    });
    await expect(
      asker.ask({
        key: "discord-bot-token",
        kind: "text",
        message: "Discord bot token",
        required: true,
        sensitive: true,
      }),
    ).resolves.toBe("from-agent");
    expect(fake.selectMessages).toEqual([]);
  });

  it("headless without a required answer throws InteractionRequired", async () => {
    const fake = createFakePrompter();
    const asker = composeIntegrationAsker({
      prompter: fake.prompter,
      headless: true,
      answers: {},
    });
    await expect(
      asker.ask({
        key: "discord-bot-token",
        kind: "text",
        message: "Discord bot token",
        required: true,
        sensitive: true,
      }),
    ).rejects.toBeInstanceOf(InteractionRequired);
  });
});

describe("runIntegrationSetup headless composition", () => {
  it("passes a headless answers-by-key Asker and headless context into setup", async () => {
    const fake = createFakePrompter();
    let capturedAsker: Asker | undefined;
    let capturedHeadless: boolean | undefined;

    vi.mocked(setupIntegration).mockReturnValue({
      kind: "discord",
      label: "Discord",
      async setup(context) {
        capturedAsker = context.ui.asker;
        capturedHeadless = context.headless;
        const token = await context.ui.asker.ask({
          key: "discord-bot-token",
          kind: "text",
          message: "Discord bot token",
          required: true,
          sensitive: true,
        } satisfies Question<string>);
        expect(token).toBe("bot-from-answers");
        return { kind: "done" };
      },
    });

    await expect(
      runIntegrationSetup(
        "discord",
        {
          appRoot: "/project",
          prompter: fake.prompter,
          headless: true,
          answers: { "discord-bot-token": "bot-from-answers" },
        },
        {
          detectDeployment: vi.fn(async () => ({ state: "unlinked" as const })),
          getVercelAuthStatus: vi.fn(async () => "authenticated" as const),
        },
      ),
    ).resolves.toEqual({ kind: "done" });

    expect(capturedHeadless).toBe(true);
    expect(capturedAsker).toBeDefined();
    // Same stack shape as withAnswers(answers)(headlessAsker()).
    const expected = withAnswers({ "discord-bot-token": "bot-from-answers" })(headlessAsker());
    await expect(
      expected.ask({
        key: "discord-bot-token",
        kind: "text",
        message: "Discord bot token",
        required: true,
        sensitive: true,
      }),
    ).resolves.toBe("bot-from-answers");
  });

  it("keeps the interactive path when headless is unset", async () => {
    const fake = createFakePrompter({
      password: () => "interactive-token",
    });
    vi.mocked(setupIntegration).mockReturnValue({
      kind: "discord",
      label: "Discord",
      async setup(context) {
        expect(context.headless).toBeUndefined();
        const token = await context.ui.asker.ask({
          key: "discord-bot-token",
          kind: "text",
          message: "Discord bot token",
          required: true,
          sensitive: true,
        });
        expect(token).toBe("interactive-token");
        return { kind: "done" };
      },
    });

    await expect(
      runIntegrationSetup(
        "discord",
        { appRoot: "/project", prompter: fake.prompter },
        {
          detectDeployment: vi.fn(async () => ({ state: "unlinked" as const })),
          getVercelAuthStatus: vi.fn(async () => "authenticated" as const),
        },
      ),
    ).resolves.toEqual({ kind: "done" });
  });
});

describe("createIntegrationSetupUi (smoke)", () => {
  it("still builds UI over a composed asker", () => {
    const fake = createFakePrompter();
    const ui = createIntegrationSetupUi({
      asker: composeIntegrationAsker({
        prompter: fake.prompter,
        headless: true,
        answers: {},
      }),
      prompter: fake.prompter,
    });
    expect(ui.asker).toBeDefined();
    expect(integrationSetupEnvironment("authenticated", { kind: "unresolved" }).vercel.kind).toBe(
      "available",
    );
  });
});

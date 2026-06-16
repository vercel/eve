import { describe, expect, it, test, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";

import { headlessAsker, InteractionRequired, interactiveAsker, type Asker } from "../ask.js";
import type { Prompter, PrompterValue, SingleSelectOptions } from "../prompter.js";
import { createDefaultSetupState, type SetupState } from "../state.js";
import type { OutputSink } from "../step.js";
import { runHeadless, runInteractive } from "../runner.js";
import { buildChatPreferenceOptions, selectChat } from "./select-chat.js";

const silentSink: OutputSink = { write: () => {} };

/** Proves a path never reaches the channel at all. */
function untouchableAsker(): Asker {
  return {
    ask(question): Promise<never> {
      throw new Error(`untouchableAsker was asked "${question.key}"`);
    },
    askMany(question): Promise<never> {
      throw new Error(`untouchableAsker was asked "${question.key}"`);
    },
  };
}

type SingleHandler = (opts: SingleSelectOptions<PrompterValue>) => PrompterValue;

function createSelectPrompter(handler: SingleHandler): {
  prompter: Prompter;
  single: SingleHandler;
} {
  const single = vi.fn(handler);
  return { prompter: createFakePrompter({ single }).prompter, single };
}

function stateWithChannels(channels: SetupState["channels"], slackbotAttached = false): SetupState {
  return { ...createDefaultSetupState(), channels: [...channels], slackbotAttached };
}

describe("buildChatPreferenceOptions", () => {
  test("offers Slack only after the connector is attached", () => {
    expect(
      buildChatPreferenceOptions({
        availableChannels: ["slack"],
        slackbotAttached: false,
      }).map((option) => option.value),
    ).not.toContain("slack");

    expect(
      buildChatPreferenceOptions({
        availableChannels: ["slack"],
        slackbotAttached: true,
      }).map((option) => option.value),
    ).toContain("slack");
  });

  test("offers Web only when the web channel was scaffolded", () => {
    expect(
      buildChatPreferenceOptions({
        availableChannels: [],
        slackbotAttached: false,
      }).map((option) => option.value),
    ).toEqual(["repl", "api", "skip"]);

    expect(
      buildChatPreferenceOptions({
        availableChannels: ["web"],
        slackbotAttached: false,
      }).map((option) => option.value),
    ).toEqual(["web", "repl", "api", "skip"]);
  });
});

describe("selectChat box", () => {
  it("uses the preset preference without asking, in both runners", async () => {
    const box = selectChat({ asker: untouchableAsker(), presetPreference: "repl" });

    const interactive = await runInteractive([box], createDefaultSetupState(), silentSink);
    expect(interactive.kind).toBe("done");
    if (interactive.kind !== "done") return;
    expect(interactive.state.chat).toBe("repl");

    const headless = await runHeadless([box], createDefaultSetupState(), silentSink);
    expect(headless.chat).toBe("repl");
  });

  it("prompts with dynamic options and the web-first initial cursor", async () => {
    let captured: SingleSelectOptions<PrompterValue> | undefined;
    const { prompter } = createSelectPrompter((opts) => {
      captured = opts;
      return "web";
    });
    const box = selectChat({ asker: interactiveAsker(prompter) });

    const result = await runInteractive(
      [box],
      stateWithChannels(["web", "slack"], true),
      silentSink,
    );

    expect(result.kind).toBe("done");
    if (result.kind !== "done") return;
    expect(result.state.chat).toBe("web");
    expect(captured?.options.map((option) => option.value)).toEqual([
      "web",
      "slack",
      "repl",
      "api",
      "skip",
    ]);
    expect(captured?.initialValue).toBe("web");
  });

  it("falls back to the Slack cursor, then to no initial cursor", async () => {
    let captured: SingleSelectOptions<PrompterValue> | undefined;
    const { prompter } = createSelectPrompter((opts) => {
      captured = opts;
      return "repl";
    });
    const box = selectChat({ asker: interactiveAsker(prompter) });

    await runInteractive([box], stateWithChannels(["slack"], true), silentSink);
    expect(captured?.initialValue).toBe("slack");

    await runInteractive([box], stateWithChannels(["slack"], false), silentSink);
    expect(captured?.options.map((option) => option.value)).toEqual(["repl", "api", "skip"]);
    expect(captured?.initialValue).toBeUndefined();
  });

  it("headless without a preset refuses with InteractionRequired naming the question", async () => {
    const box = selectChat({ asker: headlessAsker() });

    await expect(runHeadless([box], createDefaultSetupState(), silentSink)).rejects.toThrow(
      InteractionRequired,
    );
    await expect(runHeadless([box], createDefaultSetupState(), silentSink)).rejects.toMatchObject({
      message: expect.stringMatching(/Start a chat with your agent now/),
      question: expect.objectContaining({ key: "chat", required: true }),
    });
  });
});

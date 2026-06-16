import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { DEFAULT_AGENT_MODEL_ID } from "#shared/default-agent-model.js";

import { headlessAsker, interactiveAsker, type Asker } from "../ask.js";
import type { Prompter, PrompterValue, SingleSelectOptions } from "../prompter.js";
import { createDefaultSetupState } from "../state.js";
import type { OutputSink } from "../step.js";
import { runHeadless, runInteractive } from "../runner.js";
import { selectSetupMode } from "./select-setup-mode.js";

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

describe("selectSetupMode box", () => {
  it("picking one-shot records the mode and pins the default model", async () => {
    const { prompter } = createSelectPrompter(() => "one-shot");
    const box = selectSetupMode({ asker: interactiveAsker(prompter) });

    const result = await runInteractive([box], createDefaultSetupState(), silentSink);

    expect(result.kind).toBe("done");
    if (result.kind !== "done") return;
    expect(result.state.setupMode).toBe("one-shot");
    expect(result.state.modelId).toBe(DEFAULT_AGENT_MODEL_ID);
  });

  it("picking complete leaves the model for the model box", async () => {
    const { prompter } = createSelectPrompter(() => "complete");
    const box = selectSetupMode({ asker: interactiveAsker(prompter) });

    const result = await runInteractive([box], createDefaultSetupState(), silentSink);

    expect(result.kind).toBe("done");
    if (result.kind !== "done") return;
    expect(result.state.setupMode).toBe("complete");
    expect(result.state.modelId).toBe("");
  });

  it("pre-selects complete as the recommended row", async () => {
    let captured: SingleSelectOptions<PrompterValue> | undefined;
    const { prompter } = createSelectPrompter((opts) => {
      captured = opts;
      return "complete";
    });
    const box = selectSetupMode({ asker: interactiveAsker(prompter) });

    await runInteractive([box], createDefaultSetupState(), silentSink);

    expect(captured?.initialValue).toBe("complete");
  });

  it("a preset mode short-circuits both runners without asking", async () => {
    const box = selectSetupMode({ asker: untouchableAsker(), presetMode: "one-shot" });

    const interactive = await runInteractive([box], createDefaultSetupState(), silentSink);
    expect(interactive.kind).toBe("done");
    if (interactive.kind !== "done") return;
    expect(interactive.state.setupMode).toBe("one-shot");
    expect(interactive.state.modelId).toBe(DEFAULT_AGENT_MODEL_ID);

    const headless = await runHeadless([box], createDefaultSetupState(), silentSink);
    expect(headless.setupMode).toBe("one-shot");
  });

  it("a preset model overrides the one-shot default", async () => {
    const box = selectSetupMode({
      asker: untouchableAsker(),
      presetMode: "one-shot",
      presetModel: "openai/gpt-5-mini",
    });

    const next = await runHeadless([box], createDefaultSetupState(), silentSink);

    expect(next.modelId).toBe("openai/gpt-5-mini");
  });

  it("headless without a preset skips the question and stays complete", async () => {
    const box = selectSetupMode({ asker: headlessAsker() });

    const next = await runHeadless([box], createDefaultSetupState(), silentSink);

    expect(next.setupMode).toBe("complete");
    expect(next.modelId).toBe("");
  });
});

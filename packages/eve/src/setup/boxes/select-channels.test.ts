import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";

import { headlessAsker, InteractionRequired, interactiveAsker, type Asker } from "../ask.js";
import type { MultiSelectOptions, PrompterValue, SelectOption } from "../prompter.js";
import { createDefaultSetupState, type SetupState } from "../state.js";
import type { OutputSink } from "../step.js";
import { runHeadless, runInteractive } from "../runner.js";
import { selectChannels } from "./select-channels.js";

const silentSink: OutputSink = { write: () => {} };

type MultipleHandler = (opts: MultiSelectOptions<PrompterValue>) => Promise<PrompterValue[]>;

function createAsker(multiple?: MultipleHandler): Asker {
  return interactiveAsker(createFakePrompter(multiple ? { multiple } : {}).prompter);
}

function stateDeployingToVercel(): SetupState {
  return {
    ...createDefaultSetupState(),
    vercelProject: { kind: "new", project: "agent", team: "team" },
  };
}

describe("selectChannels box", () => {
  it("uses preset channels without asking", async () => {
    const box = selectChannels({
      variant: "onboarding",
      asker: headlessAsker(),
      presetChannels: ["web"],
    });

    const next = await runHeadless([box], stateDeployingToVercel(), silentSink);

    expect(next.channelSelection).toEqual(["web"]);
  });

  it("prompts a multiselect and records the selection", async () => {
    const multiselect: MultipleHandler = vi.fn(async () => ["web", "slack"]);
    const box = selectChannels({ variant: "onboarding", asker: createAsker(multiselect) });

    const result = await runInteractive([box], stateDeployingToVercel(), silentSink);

    expect(multiselect).toHaveBeenCalledOnce();
    expect(result.kind).toBe("done");
    if (result.kind !== "done") return;
    expect(result.state.channelSelection).toEqual(["web", "slack"]);
  });

  it("keeps Slack selectable during onboarding before the deployment decision", async () => {
    // The deployment question now comes after the channel picker, so the
    // onboarding variant never gates Slack; picking it is what resolves the
    // later provisioning box to Vercel.
    let options: readonly SelectOption<PrompterValue>[] = [];
    const multiselect: MultipleHandler = vi.fn(async (opts) => {
      options = opts.options;
      return ["tui", "slack"];
    });
    const box = selectChannels({ variant: "onboarding", asker: createAsker(multiselect) });

    // Default state has no Vercel plan yet: the question has not been asked.
    const result = await runInteractive([box], createDefaultSetupState(), silentSink);

    const slack = options.find((option) => option.value === "slack");
    expect(slack?.disabled).toBeUndefined();
    expect(result.kind).toBe("done");
    if (result.kind !== "done") return;
    expect(result.state.channelSelection).toEqual(["slack"]);
  });

  it("in-project: disables Slack in the picker when no project link was detected", async () => {
    let options: readonly SelectOption<PrompterValue>[] = [];
    const multiselect: MultipleHandler = vi.fn(async (opts) => {
      options = opts.options;
      return ["web"];
    });
    const box = selectChannels({ asker: createAsker(multiselect), variant: "in-project" });

    // Default state has no detected on-disk link.
    await runInteractive([box], createDefaultSetupState(), silentSink);

    const slack = options.find((option) => option.value === "slack");
    expect(slack?.disabled).toBe(true);
    expect(slack?.disabledReason).toBe("needs a Vercel project");
  });

  it("in-project: rejects a preset Slack selection without a link, in both runners", async () => {
    const box = selectChannels({
      asker: headlessAsker(),
      presetChannels: ["slack"],
      variant: "in-project",
    });

    await expect(runHeadless([box], createDefaultSetupState(), silentSink)).rejects.toThrow(
      /Slack requires a Vercel project/,
    );
    await expect(runInteractive([box], createDefaultSetupState(), silentSink)).rejects.toThrow(
      /Slack requires a Vercel project/,
    );
  });

  it("in-project: rejects an interactive Slack pick without a link", async () => {
    const multiselect: MultipleHandler = vi.fn(async () => ["tui", "slack"]);
    const box = selectChannels({ asker: createAsker(multiselect), variant: "in-project" });

    await expect(runInteractive([box], createDefaultSetupState(), silentSink)).rejects.toThrow(
      /Slack requires a Vercel project/,
    );
  });

  it("in-project: enables Slack from the detected project link", async () => {
    // In-project setup has no onboarding plan; the on-disk link alone gates.
    const state: SetupState = {
      ...createDefaultSetupState(),
      project: { kind: "linked", projectId: "prj_demo" },
    };
    const box = selectChannels({
      asker: headlessAsker(),
      presetChannels: ["slack"],
      variant: "in-project",
    });

    const next = await runHeadless([box], state, silentSink);

    expect(next.channelSelection).toEqual(["slack"]);
  });

  it("requires a selection and offers a locked, always-on Terminal UI option", async () => {
    let captured: MultiSelectOptions<PrompterValue> | undefined;
    const multiselect: MultipleHandler = vi.fn(async (opts) => {
      captured = opts;
      return ["tui", "web"];
    });
    const box = selectChannels({ variant: "onboarding", asker: createAsker(multiselect) });

    await runInteractive([box], stateDeployingToVercel(), silentSink);

    expect(captured?.required).toBe(true);
    const tui = captured?.options.find((option) => option.value === "tui");
    expect(tui?.locked).toBe(true);
    expect(tui?.disabled).toBeUndefined();
  });

  it("strips the always-on Terminal UI sentinel from the scaffolded channel selection", async () => {
    const multiselect: MultipleHandler = vi.fn(async () => ["tui", "web"]);
    const box = selectChannels({ variant: "onboarding", asker: createAsker(multiselect) });

    const result = await runInteractive([box], stateDeployingToVercel(), silentSink);

    expect(result.kind).toBe("done");
    if (result.kind !== "done") return;
    expect(result.state.channelSelection).toEqual(["web"]);
  });

  it("headless without preset channels refuses with InteractionRequired naming the question", async () => {
    const box = selectChannels({ variant: "onboarding", asker: headlessAsker() });

    await expect(runHeadless([box], stateDeployingToVercel(), silentSink)).rejects.toThrow(
      InteractionRequired,
    );
    await expect(runHeadless([box], stateDeployingToVercel(), silentSink)).rejects.toMatchObject({
      message: expect.stringMatching(/Where will you chat with your agent\?/),
      question: expect.objectContaining({ key: "channels", required: true }),
    });
  });

  it("merges disabled channel reasons into the picker rows", async () => {
    let options: readonly SelectOption<PrompterValue>[] = [];
    const multiselect: MultipleHandler = vi.fn(async (opts) => {
      options = opts.options;
      return [];
    });
    const box = selectChannels({
      asker: createAsker(multiselect),
      variant: "channels-add",
      disabledChannelReasons: {
        web: "POST /eve/v1/session already registered",
        slack: "Slack channel already registered",
      },
    });

    await runInteractive([box], createDefaultSetupState(), silentSink);

    expect(options).toEqual([
      expect.objectContaining({
        value: "web",
        disabled: true,
        disabledReason: "POST /eve/v1/session already registered",
      }),
      expect.objectContaining({
        value: "slack",
        disabled: true,
        disabledReason: "Slack channel already registered",
      }),
    ]);
  });

  it("channels-add variant drops the REPL row, allows empty submit, and keeps Slack open", async () => {
    let captured: MultiSelectOptions<PrompterValue> | undefined;
    const multiselect: MultipleHandler = vi.fn(async (opts) => {
      captured = opts;
      return [];
    });
    const box = selectChannels({ asker: createAsker(multiselect), variant: "channels-add" });

    // Default state is unlinked with no Vercel plan; the channels-add
    // composition still offers Slack because its add box links on demand.
    const result = await runInteractive([box], createDefaultSetupState(), silentSink);

    expect(captured?.required).toBe(false);
    expect(captured?.options.map((option) => option.value)).toEqual(["web", "slack"]);
    const slack = captured?.options.find((option) => option.value === "slack");
    expect(slack?.disabled).toBeUndefined();
    expect(result.kind).toBe("done");
    if (result.kind !== "done") return;
    expect(result.state.channelSelection).toEqual([]);
  });

  it("channels-add variant accepts a preset Slack selection without a Vercel project", async () => {
    const box = selectChannels({
      asker: headlessAsker(),
      variant: "channels-add",
      presetChannels: ["slack"],
    });

    const next = await runHeadless([box], createDefaultSetupState(), silentSink);

    expect(next.channelSelection).toEqual(["slack"]);
  });

  it("runs validateSelection on the preset path before recording the selection", async () => {
    const validateSelection = vi.fn(async () => {
      throw new Error("existing eve session channel");
    });
    const box = selectChannels({
      asker: headlessAsker(),
      variant: "channels-add",
      presetChannels: ["web"],
      validateSelection,
    });

    await expect(runInteractive([box], createDefaultSetupState(), silentSink)).rejects.toThrow(
      "existing eve session channel",
    );
    expect(validateSelection).toHaveBeenCalledWith(["web"]);
  });

  it("runs validateSelection on a picked selection with the REPL row stripped", async () => {
    const validateSelection = vi.fn(async () => {});
    const multiselect: MultipleHandler = vi.fn(async () => ["tui", "web"]);
    const box = selectChannels({
      variant: "onboarding",
      asker: createAsker(multiselect),
      validateSelection,
    });

    const result = await runInteractive([box], stateDeployingToVercel(), silentSink);

    expect(validateSelection).toHaveBeenCalledWith(["web"]);
    expect(result.kind).toBe("done");
  });
});

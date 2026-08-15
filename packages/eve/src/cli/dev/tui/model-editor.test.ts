import { describe, expect, it } from "vitest";

import type { GatewayModelCapabilities } from "#setup/boxes/model-capabilities.js";
import type { ModelSettingsRequest } from "#setup/flows/model.js";

import {
  initialModelEditorState,
  modelEditorMenuRows,
  reasoningPositions,
  transitionModelEditor,
  type ModelEditorEvent,
  type ModelEditorState,
} from "./model-editor.js";

const OPTIONS = [
  {
    id: "anthropic/claude-sonnet-5",
    value: "anthropic/claude-sonnet-5",
    label: "Claude Sonnet 5",
    hint: "Anthropic",
    featured: true,
  },
  { id: "xai/grok-4.5", value: "xai/grok-4.5", label: "Grok 4.5", hint: "xAI" },
  { id: "test/no-frills", value: "test/no-frills", label: "No Frills", hint: "Test" },
] as const;

const CAPABILITIES: Record<string, GatewayModelCapabilities> = {
  "anthropic/claude-sonnet-5": {
    reasoning: true,
    reasoningLevels: ["none", "minimal", "low", "medium", "high", "xhigh"],
    fastMode: true,
  },
  "xai/grok-4.5": { reasoning: true, reasoningLevels: ["low", "high"], fastMode: true },
  "test/no-frills": { reasoning: false, reasoningLevels: [], fastMode: false },
};

function request(overrides: Partial<ModelSettingsRequest> = {}): ModelSettingsRequest {
  return {
    model: { kind: "pick", options: [...OPTIONS], current: "anthropic/claude-sonnet-5" },
    reasoning: null,
    serviceTier: { kind: "standard" },
    settingsEditable: true,
    externalRouting: false,
    capabilitiesFor: (modelId) => (modelId === null ? undefined : CAPABILITIES[modelId]),
    ...overrides,
  };
}

/** Applies events in order, asserting none of them settles or cancels. */
function drive(
  req: ModelSettingsRequest,
  state: ModelEditorState,
  events: ModelEditorEvent[],
): ModelEditorState {
  let current = state;
  for (const event of events) {
    const transition = transitionModelEditor(current, event, req);
    if (transition.kind !== "render" && transition.kind !== "ignore") {
      throw new Error(`Unexpected ${transition.kind} transition for ${JSON.stringify(event)}`);
    }
    current = transition.state;
  }
  return current;
}

describe("initialModelEditorState", () => {
  it("opens the menu on the Model row with the draft seeded from authored values", () => {
    const req = request({ reasoning: "high", serviceTier: { kind: "priority" } });
    const state = initialModelEditorState(req);

    expect(state.screen).toEqual({ kind: "menu", cursor: "model" });
    expect(state.draft).toEqual({
      modelId: "anthropic/claude-sonnet-5",
      reasoning: "high",
      tier: "priority",
    });
    expect(state.capabilities?.reasoning).toBe(true);
  });

  it("opens a fixed-model menu on the first pickable row", () => {
    const req = request({
      model: { kind: "fixed", current: "anthropic/claude-sonnet-5", reason: "SDK model call" },
    });
    expect(initialModelEditorState(req).screen).toEqual({ kind: "menu", cursor: "reasoning" });
  });

  it("lands on Done when a fixed no-frills model disables everything else", () => {
    const req = request({
      model: { kind: "fixed", current: "test/no-frills", reason: "SDK model call" },
    });
    expect(initialModelEditorState(req).screen).toEqual({ kind: "menu", cursor: "done" });
  });
});

describe("modelEditorMenuRows", () => {
  it("derives pickable rows for a fully-capable pick", () => {
    const state = initialModelEditorState(request());
    const rows = modelEditorMenuRows(request(), state.draft, state.capabilities);
    expect(rows.map((row) => [row.value, row.disabled ?? false])).toEqual([
      ["model", false],
      ["reasoning", false],
      ["tier", false],
      ["done", false],
    ]);
  });

  it("disables the model row for an SDK model call, carrying the reason", () => {
    const req = request({
      model: { kind: "fixed", current: "anthropic/claude-sonnet-5", reason: "SDK model call" },
    });
    const state = initialModelEditorState(req);
    expect(modelEditorMenuRows(req, state.draft, state.capabilities)[0]).toEqual({
      value: "model",
      label: "Model",
      disabled: true,
      description: "SDK model call",
    });
  });

  it("disables reasoning with its explanation and omits the tier for a no-frills model", () => {
    const req = request({
      model: { kind: "pick", options: [...OPTIONS], current: "test/no-frills" },
    });
    const state = initialModelEditorState(req);
    const rows = modelEditorMenuRows(req, state.draft, state.capabilities);
    expect(rows.map((row) => row.value)).toEqual(["model", "reasoning", "done"]);
    expect(rows[1]).toMatchObject({
      disabled: true,
      description: "Not supported by the selected model",
    });
  });

  it("keeps a static tier row for custom tiers and external routing", () => {
    const state = initialModelEditorState(request());
    const custom = modelEditorMenuRows(
      request({ serviceTier: { kind: "custom", value: "flex" } }),
      state.draft,
      state.capabilities,
    );
    expect(custom.find((row) => row.value === "tier")).toMatchObject({
      disabled: true,
      description: "Custom (flex) — authored in agent.ts",
    });

    const external = modelEditorMenuRows(
      request({ externalRouting: true }),
      state.draft,
      state.capabilities,
    );
    expect(external.find((row) => row.value === "tier")).toMatchObject({
      disabled: true,
      description: "Disabled for a direct external provider",
    });
  });
});

describe("reasoningPositions", () => {
  it("orders notches as the supported levels, inserting a drafted stray", () => {
    expect(reasoningPositions(CAPABILITIES["xai/grok-4.5"], "medium")).toEqual([
      "low",
      "medium",
      "high",
    ]);
  });

  it("offers every level when the catalog does not know the model", () => {
    expect(reasoningPositions(undefined, "default")).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });
});

describe("menu screen", () => {
  it("moves the cursor with wrap while skipping disabled rows", () => {
    const req = request({
      model: { kind: "pick", options: [...OPTIONS], current: "test/no-frills" },
    });
    let state = initialModelEditorState(req);
    // Rows: model / reasoning(disabled) / done — down skips the disabled row.
    state = drive(req, state, [{ type: "move", direction: "down" }]);
    expect(state.screen).toEqual({ kind: "menu", cursor: "done" });
    state = drive(req, state, [{ type: "move", direction: "down" }]);
    expect(state.screen).toEqual({ kind: "menu", cursor: "model" });
  });

  it("cancels straight out from the menu", () => {
    const req = request();
    expect(transitionModelEditor(initialModelEditorState(req), { type: "cancel" }, req)).toEqual({
      kind: "cancel",
    });
  });

  it("opens the model list on Enter and walks past inline rows instead", () => {
    const req = request({ reasoning: "high", serviceTier: { kind: "priority" } });
    const state = initialModelEditorState(req);

    const model = transitionModelEditor(state, { type: "submit" }, req);
    expect(model.kind).toBe("render");
    if (model.kind !== "render") return;
    expect(model.state.screen.kind).toBe("model");

    // Enter on an inline value row is just a downward step.
    const onReasoning = drive(req, state, [{ type: "move", direction: "down" }]);
    const stepped = drive(req, onReasoning, [{ type: "submit" }]);
    expect(stepped.screen).toEqual({ kind: "menu", cursor: "tier" });
    expect(stepped.draft.reasoning).toBe("high");
  });
});

describe("model sub-screen", () => {
  it("filters, clears the filter on Esc, and returns to the menu on a second Esc", () => {
    const req = request();
    let state = drive(req, initialModelEditorState(req), [{ type: "submit" }]);
    state = drive(req, state, [
      { type: "char", char: "g" },
      { type: "char", char: "r" },
    ]);
    expect(state.screen.kind === "model" && state.screen.select.filter).toBe("gr");

    state = drive(req, state, [{ type: "cancel" }]);
    expect(state.screen.kind === "model" && state.screen.select.filter).toBe("");

    state = drive(req, state, [{ type: "cancel" }]);
    expect(state.screen).toEqual({ kind: "menu", cursor: "model" });
    // Esc changed nothing.
    expect(state.draft.modelId).toBe("anthropic/claude-sonnet-5");
  });

  it("commits a pick into the draft, recomputes capabilities, and returns to the menu", () => {
    const req = request();
    let state = drive(req, initialModelEditorState(req), [
      { type: "submit" },
      { type: "char", char: "grok" },
    ]);
    state = drive(req, state, [{ type: "submit" }]);

    expect(state.screen).toEqual({ kind: "menu", cursor: "model" });
    expect(state.draft.modelId).toBe("xai/grok-4.5");
    expect(state.capabilities?.reasoningLevels).toEqual(["low", "high"]);
  });

  it("snaps a drafted level the picked model cannot serve to its closest supported one", () => {
    const req = request({ reasoning: "xhigh" });
    let state = drive(req, initialModelEditorState(req), [
      { type: "submit" },
      { type: "char", char: "grok" },
      { type: "submit" },
    ]);
    // grok supports only low/high: xhigh lands on high, not a stray notch.
    expect(state.draft.reasoning).toBe("high");

    // A model with no adjustable reasoning clears the level entirely.
    state = drive(req, state, [
      { type: "submit" },
      { type: "char", char: "frills" },
      { type: "submit" },
    ]);
    expect(state.draft.reasoning).toBe("default");
  });

  it("keeps a supported drafted level and an unset draft across picks", () => {
    const req = request({ reasoning: "low" });
    const state = drive(req, initialModelEditorState(req), [
      { type: "submit" },
      { type: "char", char: "grok" },
      { type: "submit" },
    ]);
    expect(state.draft.reasoning).toBe("low");

    const unset = request();
    const picked = drive(unset, initialModelEditorState(unset), [
      { type: "submit" },
      { type: "char", char: "frills" },
      { type: "submit" },
    ]);
    expect(picked.draft.reasoning).toBe("default");
  });

  it("ignores submit when the filter matches nothing", () => {
    const req = request();
    const state = drive(req, initialModelEditorState(req), [
      { type: "submit" },
      { type: "char", char: "zzz" },
    ]);
    expect(transitionModelEditor(state, { type: "submit" }, req).kind).toBe("ignore");
  });
});

describe("inline reasoning adjust", () => {
  function onReasoning(req: ModelSettingsRequest): ModelEditorState {
    return drive(req, initialModelEditorState(req), [{ type: "move", direction: "down" }]);
  }

  it("adjusts the draft by one step and wraps as a ring at both ends", () => {
    const req = request({ reasoning: "high" });
    let state = onReasoning(req);
    state = drive(req, state, [{ type: "adjust", direction: "right" }]);
    expect(state.draft.reasoning).toBe("xhigh");
    expect(state.screen).toEqual({ kind: "menu", cursor: "reasoning" });

    // Right past the top wraps to the first level; left wraps back.
    state = drive(req, state, [{ type: "adjust", direction: "right" }]);
    expect(state.draft.reasoning).toBe("none");
    state = drive(req, state, [{ type: "adjust", direction: "left" }]);
    expect(state.draft.reasoning).toBe("xhigh");
  });

  it("enters the ring from an unset draft: right at the lowest, left at the highest", () => {
    const req = request();
    let state = onReasoning(req);
    expect(state.draft.reasoning).toBe("default");

    const entered = drive(req, state, [{ type: "adjust", direction: "left" }]);
    expect(entered.draft.reasoning).toBe("xhigh");

    state = drive(req, state, [{ type: "adjust", direction: "right" }]);
    expect(state.draft.reasoning).toBe("none");
  });

  it("ignores adjust away from the value rows", () => {
    const req = request();
    const state = initialModelEditorState(req);
    expect(state.screen).toEqual({ kind: "menu", cursor: "model" });
    expect(transitionModelEditor(state, { type: "adjust", direction: "right" }, req).kind).toBe(
      "ignore",
    );
  });
});

describe("inline tier adjust", () => {
  it("flips the tier on either arrow — a two-value ring, so Tab always acts", () => {
    const req = request();
    let state = drive(req, initialModelEditorState(req), [
      { type: "move", direction: "down" },
      { type: "move", direction: "down" },
    ]);
    expect(state.screen).toEqual({ kind: "menu", cursor: "tier" });

    state = drive(req, state, [{ type: "adjust", direction: "right" }]);
    expect(state.draft.tier).toBe("priority");
    state = drive(req, state, [{ type: "adjust", direction: "right" }]);
    expect(state.draft.tier).toBe("standard");
    state = drive(req, state, [{ type: "adjust", direction: "left" }]);
    expect(state.draft.tier).toBe("priority");
  });

  it("drops a drafted priority tier when the picked model prices no fast mode", () => {
    // Drafted (not authored) priority: the pick must reset it, or the hidden
    // row leaves it stuck and it leaks into the settle result.
    const req = request();
    let state = drive(req, initialModelEditorState(req), [
      { type: "move", direction: "down" },
      { type: "move", direction: "down" },
      { type: "adjust", direction: "right" }, // tier → priority
      { type: "move", direction: "up" },
      { type: "move", direction: "up" },
      { type: "submit" },
      { type: "char", char: "frills" },
      { type: "submit" }, // model → test/no-frills, fastMode: false
    ]);
    expect(state.draft.tier).toBe("standard");

    // Priority survives a pick between two fast-mode models.
    const priority = request({ serviceTier: { kind: "priority" } });
    state = drive(priority, initialModelEditorState(priority), [
      { type: "submit" },
      { type: "char", char: "grok" },
      { type: "submit" },
    ]);
    expect(state.draft.tier).toBe("priority");
  });

  it("hides the tier row after a pick of a model without the tier", () => {
    const req = request();
    let state = drive(req, initialModelEditorState(req), [
      { type: "submit" },
      { type: "char", char: "frills" },
      { type: "submit" },
    ]);
    const rows = modelEditorMenuRows(req, state.draft, state.capabilities);
    expect(rows.map((row) => row.value)).toEqual(["model", "reasoning", "done"]);
    // The menu cursor stays valid: moving down from Model skips to Done.
    state = drive(req, state, [{ type: "move", direction: "down" }]);
    expect(state.screen).toEqual({ kind: "menu", cursor: "done" });
  });
});

describe("settling", () => {
  function toDone(req: ModelSettingsRequest, state: ModelEditorState): ModelEditorState {
    let current = state;
    for (
      let i = 0;
      i < 4 && (current.screen.kind !== "menu" || current.screen.cursor !== "done");
      i += 1
    ) {
      current = drive(req, current, [{ type: "move", direction: "down" }]);
    }
    return current;
  }

  it("settles with only the fields that differ from the authored values", () => {
    const req = request({ reasoning: "medium" });
    let state = drive(req, initialModelEditorState(req), [
      { type: "submit" },
      { type: "char", char: "grok" },
      { type: "submit" }, // model → xai/grok-4.5
      { type: "move", direction: "down" },
      { type: "adjust", direction: "right" }, // medium (stray between low/high) → high
      { type: "move", direction: "down" },
      { type: "adjust", direction: "right" }, // tier → priority
    ]);
    state = toDone(req, state);

    expect(transitionModelEditor(state, { type: "submit" }, req)).toEqual({
      kind: "settle",
      result: { model: "xai/grok-4.5", reasoning: "high", serviceTier: "priority" },
    });
  });

  it("settles with an empty result when nothing changed", () => {
    const req = request();
    const state = toDone(req, initialModelEditorState(req));
    expect(transitionModelEditor(state, { type: "submit" }, req)).toEqual({
      kind: "settle",
      result: {},
    });
  });

  it("maps a dropped tier to its remove sentinel", () => {
    const req = request({ serviceTier: { kind: "priority" } });
    let state = drive(req, initialModelEditorState(req), [
      { type: "move", direction: "down" },
      { type: "move", direction: "down" },
      { type: "adjust", direction: "left" }, // priority → standard
    ]);
    state = toDone(req, state);

    expect(transitionModelEditor(state, { type: "submit" }, req)).toEqual({
      kind: "settle",
      result: { serviceTier: "standard" },
    });
  });

  it("settles an authored priority tier down to standard when the pick loses fast mode", () => {
    const req = request({ serviceTier: { kind: "priority" } });
    let state = drive(req, initialModelEditorState(req), [
      { type: "submit" },
      { type: "char", char: "frills" },
      { type: "submit" },
    ]);
    state = toDone(req, state);

    expect(transitionModelEditor(state, { type: "submit" }, req)).toEqual({
      kind: "settle",
      result: { model: "test/no-frills", serviceTier: "standard" },
    });
  });

  it("never reports tier changes for custom configurations", () => {
    const req = request({ serviceTier: { kind: "custom", value: "flex" } });
    const state = toDone(req, initialModelEditorState(req));
    expect(transitionModelEditor(state, { type: "submit" }, req)).toEqual({
      kind: "settle",
      result: {},
    });
  });
});

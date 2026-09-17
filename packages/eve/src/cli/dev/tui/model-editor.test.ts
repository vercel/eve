import { describe, expect, it } from "vitest";
import type { ModelSettingsRequest } from "#setup/flows/model.js";
import {
  initialModelEditorState,
  modelEditorMenuRows,
  transitionModelEditor,
  type ModelEditorState,
  type ModelEditorEvent,
} from "./model-editor.js";
const request: ModelSettingsRequest = {
  model: {
    kind: "pick",
    current: "openai/gpt-5.6-luna-fast",
    options: [
      { value: "openai/gpt-5.6-luna-fast", label: "Luna" },
      { value: "anthropic/claude-sonnet-5", label: "Sonnet" },
      { value: "test/no-reasoning", label: "Simple" },
    ],
  },
  reasoning: "high",
  serviceTier: { kind: "priority" },
  settingsEditable: true,
  externalRouting: false,
  capabilitiesFor: (id) =>
    id === "test/no-reasoning"
      ? { reasoning: false, reasoningLevels: [], fastMode: false }
      : { reasoning: true, reasoningLevels: ["low", "high"], fastMode: true },
};
function drive(events: ModelEditorEvent[], req = request): ModelEditorState {
  let state = initialModelEditorState(req);
  for (const event of events) {
    const result = transitionModelEditor(state, event, req);
    if (result.kind !== "render" && result.kind !== "ignore")
      throw new Error(`Unexpected ${result.kind}`);
    state = result.state;
  }
  return state;
}
describe("model editor", () => {
  it("has model, reasoning and tier settings without a Done row", () => {
    const state = initialModelEditorState(request);
    expect(
      modelEditorMenuRows(request, state.draft, state.capabilities).map((row) => row.value),
    ).toEqual(["model", "reasoning", "tier"]);
  });
  it("applies a filtered model on Enter", () => {
    const state = drive([{ type: "submit" }, { type: "char", char: "Sonnet" }]);
    expect(transitionModelEditor(state, { type: "submit" }, request)).toEqual({
      kind: "settle",
      result: { model: "anthropic/claude-sonnet-5" },
    });
  });
  it("clears a filter before returning to settings on Esc", () => {
    const state = drive([
      { type: "submit" },
      { type: "char", char: "Luna" },
      { type: "cancel" },
      { type: "cancel" },
    ]);
    expect(state.screen).toEqual({ kind: "menu", cursor: "model" });
    expect(transitionModelEditor(state, { type: "cancel" }, request)).toEqual({ kind: "cancel" });
  });
  it("does not submit a filter with no matches", () => {
    const state = drive([{ type: "submit" }, { type: "char", char: "missing" }]);
    expect(transitionModelEditor(state, { type: "submit" }, request).kind).toBe("ignore");
  });
  it("applies a reasoning choice on Enter", () => {
    const state = drive([
      { type: "move", direction: "down" },
      { type: "adjust", direction: "left" },
    ]);
    expect(transitionModelEditor(state, { type: "submit" }, request)).toEqual({
      kind: "settle",
      result: { reasoning: "low" },
    });
  });
  it("applies a service tier choice on Enter", () => {
    const state = drive([
      { type: "move", direction: "down" },
      { type: "move", direction: "down" },
      { type: "adjust", direction: "left" },
    ]);
    expect(transitionModelEditor(state, { type: "submit" }, request)).toEqual({
      kind: "settle",
      result: { serviceTier: "standard" },
    });
  });
  it("drops incompatible reasoning and priority tier when changing models", () => {
    const state = drive([{ type: "submit" }, { type: "char", char: "Simple" }]);
    expect(transitionModelEditor(state, { type: "submit" }, request)).toEqual({
      kind: "settle",
      result: { model: "test/no-reasoning", reasoning: "default", serviceTier: "standard" },
    });
  });
  it("leaves an SDK model fixed while allowing supported settings", () => {
    const req: ModelSettingsRequest = {
      ...request,
      model: { kind: "fixed", current: "custom", reason: "Authored in agent.ts" },
    };
    const state = initialModelEditorState(req);
    expect(state.screen).toEqual({ kind: "menu", cursor: "reasoning" });
    expect(modelEditorMenuRows(req, state.draft, state.capabilities)[0]?.disabled).toBe(true);
  });
});

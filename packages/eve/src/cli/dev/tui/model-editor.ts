import { ALL_REASONING_LEVELS, type ReasoningLevel } from "#setup/boxes/model-capabilities.js";
import type { GatewayModelCapabilities } from "#setup/boxes/model-capabilities.js";
import {
  filterOptions,
  initialSelectState,
  reduceSelect,
  selectValueAtCursor,
  type SelectState,
} from "#setup/cli/select-state.js";
import type { ModelSettingsRequest, ModelSettingsResult } from "#setup/flows/model.js";
import type { SelectOption } from "#setup/prompter.js";

/** The Change-model menu's rows, in visual order. */
export type ModelEditorRowId = "model" | "reasoning" | "tier" | "done";

/**
 * The screen stack, depth two: the value menu, or the model list it opens.
 * Reasoning and tier adjust inline on their menu rows — only the catalog pick
 * warrants its own screen. The list carries scratch select state seeded when
 * opened; Esc drops it, so "returns unchanged" is structural.
 */
export type ModelEditorScreen =
  | { kind: "menu"; cursor: ModelEditorRowId }
  | { kind: "model"; select: SelectState };

/** The in-progress values; nothing lands in source until the menu's Done. */
export interface ModelEditorDraft {
  modelId: string | null;
  reasoning: "default" | ReasoningLevel;
  tier: "standard" | "priority";
}

/** One Change-model interaction, advanced by {@link transitionModelEditor}. */
export interface ModelEditorState {
  screen: ModelEditorScreen;
  draft: ModelEditorDraft;
  /** Catalog capabilities for `draft.modelId`; recomputed on every pick. */
  capabilities: GatewayModelCapabilities | undefined;
}

/** Semantic input after terminal-key decoding. */
export type ModelEditorEvent =
  | { type: "move"; direction: "up" | "down" }
  | { type: "adjust"; direction: "left" | "right" }
  | { type: "char"; char: string }
  | { type: "backspace" }
  | { type: "cancel" }
  | { type: "submit" };

export type ModelEditorTransition =
  | { kind: "ignore"; state: ModelEditorState }
  | { kind: "render"; state: ModelEditorState }
  | { kind: "cancel" }
  | { kind: "settle"; result: ModelSettingsResult };

/**
 * How a value row presents: an adjustable control, a dim explanatory line the
 * cursor skips, or nothing at all — a control that cannot apply to the
 * drafted model (no priority tier) is noise, while an authored-but-unowned
 * state (custom tier, external provider) still explains itself.
 */
export type ModelEditorSectionView =
  | { kind: "interactive" }
  | { kind: "static"; text: string }
  | { kind: "hidden" };

const NOT_EDITABLE_TEXT = "No editable agent.ts config object is available";

/**
 * The reasoning row stays interactive while a level is drafted even when the
 * catalog disowns reasoning, so the authored value at least stays visible.
 */
export function reasoningSectionView(
  request: ModelSettingsRequest,
  draft: ModelEditorDraft,
  capabilities: GatewayModelCapabilities | undefined,
): ModelEditorSectionView {
  if (!request.settingsEditable) return { kind: "static", text: NOT_EDITABLE_TEXT };
  if (capabilities?.reasoning === false && draft.reasoning === "default") {
    return { kind: "static", text: "Not supported by the selected model" };
  }
  return { kind: "interactive" };
}

/** The tier row's presentation; static or hidden for every state it cannot own. */
export function tierSectionView(
  request: ModelSettingsRequest,
  capabilities: GatewayModelCapabilities | undefined,
): ModelEditorSectionView {
  if (!request.settingsEditable) return { kind: "static", text: NOT_EDITABLE_TEXT };
  if (request.externalRouting) {
    return { kind: "static", text: "Disabled for a direct external provider" };
  }
  if (request.serviceTier.kind === "custom") {
    return { kind: "static", text: `Custom (${request.serviceTier.value}) — authored in agent.ts` };
  }
  // Pure availability: a model the catalog prices no priority tier for never
  // shows the row, and a model with one always does — the drafted value has
  // no say, so the row cannot vanish underneath its own toggle.
  if (capabilities !== undefined && !capabilities.fastMode) {
    return { kind: "hidden" };
  }
  return { kind: "interactive" };
}

/**
 * The track's notch positions: the levels the catalog supports (every level
 * when capabilities are unknown). The provider default is not a notch — an
 * unset draft renders an empty track and the first right-adjust enters the
 * scale at the lowest level. A drafted level the catalog does not list is
 * inserted in canonical level order, so the track never hides the value it
 * is about to replace.
 */
export function reasoningPositions(
  capabilities: GatewayModelCapabilities | undefined,
  drafted: "default" | ReasoningLevel,
): readonly ReasoningLevel[] {
  const levels = capabilities === undefined ? ALL_REASONING_LEVELS : capabilities.reasoningLevels;
  const positions: ReasoningLevel[] = [...levels];
  if (drafted !== "default" && !positions.includes(drafted)) {
    const rank = ALL_REASONING_LEVELS.indexOf(drafted);
    const insertAt = positions.findIndex(
      (position) => ALL_REASONING_LEVELS.indexOf(position) > rank,
    );
    if (insertAt === -1) positions.push(drafted);
    else positions.splice(insertAt, 0, drafted);
  }
  return positions;
}

/**
 * The drafted level a freshly-picked model can actually serve: kept when the
 * new model supports it, snapped to the closest supported level by canonical
 * rank when it does not (ties resolve to the cheaper level), and cleared to
 * the provider default when the model has no adjustable reasoning at all. An
 * unset draft stays unset.
 */
function snapReasoningToCapabilities(
  drafted: "default" | ReasoningLevel,
  capabilities: GatewayModelCapabilities | undefined,
): "default" | ReasoningLevel {
  if (drafted === "default" || capabilities === undefined) return drafted;
  const levels = capabilities.reasoningLevels;
  if (!capabilities.reasoning || levels.length === 0) return "default";
  if (levels.includes(drafted)) return drafted;
  const rank = ALL_REASONING_LEVELS.indexOf(drafted);
  let closest = levels[0]!;
  for (const level of levels) {
    const distance = Math.abs(ALL_REASONING_LEVELS.indexOf(level) - rank);
    const best = Math.abs(ALL_REASONING_LEVELS.indexOf(closest) - rank);
    if (distance < best) closest = level;
  }
  return closest;
}

/**
 * The value menu's rows, derived fresh from the draft on every transition and
 * paint: interactive sections are pickable rows, static sections are disabled
 * rows carrying their explanation, and a hidden tier is omitted entirely.
 * Value hints are the painter's job — it styles them with theme glyphs.
 */
export function modelEditorMenuRows(
  request: ModelSettingsRequest,
  draft: ModelEditorDraft,
  capabilities: GatewayModelCapabilities | undefined,
): SelectOption<ModelEditorRowId>[] {
  const rows: SelectOption<ModelEditorRowId>[] = [];
  if (request.model.kind === "pick") {
    rows.push({ value: "model", label: "Model" });
  } else {
    rows.push({
      value: "model",
      label: "Model",
      disabled: true,
      description: request.model.reason,
    });
  }

  const reasoning = reasoningSectionView(request, draft, capabilities);
  if (reasoning.kind === "static") {
    rows.push({
      value: "reasoning",
      label: "Reasoning effort",
      disabled: true,
      description: reasoning.text,
    });
  } else {
    rows.push({ value: "reasoning", label: "Reasoning effort" });
  }

  const tier = tierSectionView(request, capabilities);
  if (tier.kind === "interactive") {
    rows.push({ value: "tier", label: "Service tier" });
  } else if (tier.kind === "static") {
    rows.push({ value: "tier", label: "Service tier", disabled: true, description: tier.text });
  }

  rows.push({ value: "done", label: "Done" });
  return rows;
}

/** Creates the screen's state; the cursor opens on the first pickable row. */
export function initialModelEditorState(request: ModelSettingsRequest): ModelEditorState {
  const draft: ModelEditorDraft = {
    modelId: request.model.current,
    reasoning: request.reasoning ?? "default",
    tier: request.serviceTier.kind === "priority" ? "priority" : "standard",
  };
  const capabilities = request.capabilitiesFor(draft.modelId);
  const rows = modelEditorMenuRows(request, draft, capabilities);
  const cursor = rows.find((row) => row.disabled !== true)?.value ?? "done";
  return { screen: { kind: "menu", cursor }, draft, capabilities };
}

/** A fresh search list opened on the drafted model with no filter. */
function expandedModelSelect(request: ModelSettingsRequest, modelId: string | null): SelectState {
  const options = request.model.kind === "pick" ? request.model.options : [];
  const input: Parameters<typeof initialSelectState>[0] = { options };
  if (modelId !== null) input.defaultValue = modelId;
  return initialSelectState(input);
}

function ignore(state: ModelEditorState): ModelEditorTransition {
  return { kind: "ignore", state };
}

function toMenu(state: ModelEditorState, cursor: ModelEditorRowId): ModelEditorTransition {
  return { kind: "render", state: { ...state, screen: { kind: "menu", cursor } } };
}

/** The settle payload: only the fields that differ from the authored values. */
function settleResult(request: ModelSettingsRequest, draft: ModelEditorDraft): ModelSettingsResult {
  const result: ModelSettingsResult = {};
  if (
    request.model.kind === "pick" &&
    draft.modelId !== null &&
    draft.modelId !== request.model.current
  ) {
    result.model = draft.modelId;
  }
  if (!request.settingsEditable) return result;
  if (draft.reasoning !== (request.reasoning ?? "default")) result.reasoning = draft.reasoning;
  const tierOwned = !request.externalRouting && request.serviceTier.kind !== "custom";
  const authoredTier = request.serviceTier.kind === "priority" ? "priority" : "standard";
  if (tierOwned && draft.tier !== authoredTier) result.serviceTier = draft.tier;
  return result;
}

/** One inline left/right adjustment of the row under the menu cursor. */
function adjustMenuValue(
  state: ModelEditorState,
  request: ModelSettingsRequest,
  cursor: ModelEditorRowId,
  direction: "left" | "right",
): ModelEditorTransition {
  const delta = direction === "left" ? -1 : 1;
  if (cursor === "reasoning") {
    if (reasoningSectionView(request, state.draft, state.capabilities).kind !== "interactive") {
      return ignore(state);
    }
    const positions = reasoningPositions(state.capabilities, state.draft.reasoning);
    if (positions.length === 0) return ignore(state);
    // The provider default is not a notch: right enters the ring at the lowest
    // level and left at the highest. On the ring, both directions wrap.
    const index =
      state.draft.reasoning === "default" ? -1 : positions.indexOf(state.draft.reasoning);
    const next =
      index === -1
        ? positions[delta === 1 ? 0 : positions.length - 1]!
        : positions[(index + delta + positions.length) % positions.length]!;
    if (next === state.draft.reasoning) return ignore(state);
    return { kind: "render", state: { ...state, draft: { ...state.draft, reasoning: next } } };
  }
  if (cursor === "tier") {
    if (tierSectionView(request, state.capabilities).kind !== "interactive") {
      return ignore(state);
    }
    // A two-value ring: either arrow (and Tab) flips the tier.
    const next = state.draft.tier === "priority" ? "standard" : "priority";
    return { kind: "render", state: { ...state, draft: { ...state.draft, tier: next } } };
  }
  return ignore(state);
}

function transitionMenu(
  state: ModelEditorState,
  event: ModelEditorEvent,
  request: ModelSettingsRequest,
  cursor: ModelEditorRowId,
): ModelEditorTransition {
  const rows = modelEditorMenuRows(request, state.draft, state.capabilities);

  switch (event.type) {
    case "cancel":
      return { kind: "cancel" };
    case "move": {
      // Shared select stepping over the derived rows: wraps, skips disabled.
      const index = Math.max(
        0,
        rows.findIndex((row) => row.value === cursor),
      );
      const stepped = reduceSelect(
        { filter: "", cursor: index, selected: new Set() },
        { type: event.direction },
        { options: rows },
      );
      const next = rows[stepped.cursor]?.value;
      if (next === undefined || next === cursor) return ignore(state);
      return toMenu(state, next);
    }
    case "adjust":
      return adjustMenuValue(state, request, cursor, event.direction);
    case "submit": {
      const row = rows.find((entry) => entry.value === cursor);
      if (row === undefined || row.disabled === true) return ignore(state);
      if (cursor === "model") {
        return {
          kind: "render",
          state: {
            ...state,
            screen: { kind: "model", select: expandedModelSelect(request, state.draft.modelId) },
          },
        };
      }
      if (cursor === "done") {
        return { kind: "settle", result: settleResult(request, state.draft) };
      }
      // Enter on an inline value confirms nothing new — it just walks on.
      return transitionMenu(state, { type: "move", direction: "down" }, request, cursor);
    }
    case "char":
    case "backspace":
      return ignore(state);
  }
}

function transitionModelScreen(
  state: ModelEditorState,
  event: ModelEditorEvent,
  request: ModelSettingsRequest,
  select: SelectState,
): ModelEditorTransition {
  const options = request.model.kind === "pick" ? request.model.options : [];
  const renderSelect = (next: SelectState): ModelEditorTransition =>
    next === select
      ? ignore(state)
      : { kind: "render", state: { ...state, screen: { kind: "model", select: next } } };

  switch (event.type) {
    case "cancel":
      if (select.filter.length > 0) {
        return renderSelect(reduceSelect(select, { type: "clear" }, { options }));
      }
      return toMenu(state, "model");
    case "move":
      return renderSelect(reduceSelect(select, { type: event.direction }, { options }));
    case "char":
      return renderSelect(reduceSelect(select, { type: "char", char: event.char }, { options }));
    case "backspace":
      return renderSelect(reduceSelect(select, { type: "backspace" }, { options }));
    case "submit": {
      const visible = filterOptions(options, select.filter);
      const value = selectValueAtCursor(visible, select.cursor);
      if (value === undefined) return ignore(state);
      const capabilities = request.capabilitiesFor(value);
      return {
        kind: "render",
        state: {
          screen: { kind: "menu", cursor: "model" },
          draft: {
            ...state.draft,
            modelId: value,
            // A level the new model cannot serve must not survive the pick.
            reasoning: snapReasoningToCapabilities(state.draft.reasoning, capabilities),
            // Nor a priority tier the new model prices no fast mode for — the
            // hidden tier row would leave it drafted with no way to toggle it
            // back, and it would leak into the settle result.
            tier:
              capabilities !== undefined && !capabilities.fastMode ? "standard" : state.draft.tier,
          },
          capabilities,
        },
      };
    }
    case "adjust":
      return ignore(state);
  }
}

/** Applies one keypress worth of semantics; terminal resources stay in the renderer. */
export function transitionModelEditor(
  state: ModelEditorState,
  event: ModelEditorEvent,
  request: ModelSettingsRequest,
): ModelEditorTransition {
  switch (state.screen.kind) {
    case "menu":
      return transitionMenu(state, event, request, state.screen.cursor);
    case "model":
      return transitionModelScreen(state, event, request, state.screen.select);
  }
}

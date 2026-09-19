import { ALL_REASONING_LEVELS, type ReasoningLevel } from "#setup/boxes/model-capabilities.js";
import {
  filterOptions,
  initialSelectState,
  reduceSelect,
  selectValueAtCursor,
  type SelectState,
} from "#setup/cli/select-state.js";
import type { ModelSettingsRequest, ModelSettingsResult } from "#setup/flows/model.js";
import type { SelectOption } from "#setup/prompter.js";

import { renderSelectQuestion } from "./setup-panel.js";
import type { Theme } from "./theme.js";

type ModelPickerStep = "model" | "speed" | "reasoning";

interface ModelPickerDraft {
  model: string | null;
  speed: "standard" | "priority";
  reasoning: "default" | ReasoningLevel;
}

interface ModelPickerPage {
  step: ModelPickerStep;
  select: SelectState;
  draft: ModelPickerDraft;
}

export interface ModelPickerState extends ModelPickerPage {
  history: readonly Pick<ModelPickerPage, "step" | "select">[];
}

export type ModelPickerEvent =
  | { type: "up" }
  | { type: "down" }
  | { type: "back" }
  | { type: "cancel" }
  | { type: "submit" }
  | { type: "backspace" }
  | { type: "char"; char: string };

export type ModelPickerTransition =
  | { kind: "render"; state: ModelPickerState }
  | { kind: "cancel" }
  | { kind: "settle"; result: ModelSettingsResult };

const SPEED_OPTIONS: readonly SelectOption<ModelPickerDraft["speed"]>[] = [
  { value: "standard", label: "Standard", hint: "Normal speed and pricing" },
  { value: "priority", label: "Fast", hint: "Priority processing, higher cost" },
];

const REASONING_COPY: Record<ReasoningLevel, { label: string; hint: string }> = {
  none: { label: "None", hint: "No reasoning" },
  minimal: { label: "Minimal", hint: "The least thinking" },
  low: { label: "Low", hint: "Less thinking, quicker answers" },
  medium: { label: "Medium", hint: "Balance thinking and response time" },
  high: { label: "High", hint: "More thinking for harder tasks" },
  xhigh: { label: "Extra high", hint: "The most thinking, slower answers" },
};

const REASONING_OPTIONS: readonly SelectOption<ModelPickerDraft["reasoning"]>[] = [
  { value: "default", label: "Provider default", hint: "Use the model's default reasoning" },
  ...ALL_REASONING_LEVELS.map((value) => ({ value, ...REASONING_COPY[value] })),
];

function modelOptions(request: ModelSettingsRequest): readonly SelectOption<string>[] {
  if (request.model.kind === "fixed") {
    return [{ value: "fixed", label: request.model.current ?? "Configured in agent.ts" }];
  }
  const { options, current } = request.model;
  if (current === null || options.some((option) => option.value === current)) return options;
  // A saved model can outlive its catalog listing; Enter must not silently replace it.
  return [{ value: current, label: current, hint: "Current model" }, ...options];
}

function stepOptions(
  request: ModelSettingsRequest,
  draft: ModelPickerDraft,
  step: ModelPickerStep,
): readonly SelectOption<string>[] {
  switch (step) {
    case "model":
      return modelOptions(request);
    case "speed":
      return SPEED_OPTIONS;
    case "reasoning": {
      const levels = reasoningLevels(request, draft);
      return REASONING_OPTIONS.filter(
        (option) => option.value === "default" || levels.includes(option.value),
      );
    }
  }
}

function reasoningLevels(
  request: ModelSettingsRequest,
  draft: ModelPickerDraft,
): readonly ReasoningLevel[] {
  const capabilities = request.capabilitiesFor(draft.model);
  if (capabilities !== undefined) return capabilities.reasoning ? capabilities.reasoningLevels : [];
  // Without catalog evidence, only keep or clear a setting already authored for this model.
  return draft.model === request.model.current && request.reasoning !== null
    ? [request.reasoning]
    : [];
}

function nextStep(
  request: ModelSettingsRequest,
  draft: ModelPickerDraft,
  step: ModelPickerStep,
): Exclude<ModelPickerStep, "model"> | undefined {
  if (!request.settingsEditable) return undefined;
  const capabilities = request.capabilitiesFor(draft.model);
  if (
    step === "model" &&
    !request.externalRouting &&
    request.serviceTier.kind !== "custom" &&
    (capabilities?.fastMode ||
      (capabilities === undefined &&
        draft.model === request.model.current &&
        request.serviceTier.kind === "priority"))
  ) {
    return "speed";
  }
  if (step !== "reasoning" && reasoningLevels(request, draft).length > 0) {
    return "reasoning";
  }
  return undefined;
}

export function initialModelPickerState(request: ModelSettingsRequest): ModelPickerState {
  const draft: ModelPickerDraft = {
    model: request.model.current,
    speed: request.serviceTier.kind === "priority" ? "priority" : "standard",
    reasoning: request.reasoning ?? "default",
  };
  return {
    step: "model",
    draft,
    select: initialSelectState({
      options: modelOptions(request),
      defaultValue: draft.model ?? undefined,
    }),
    history: [],
  };
}

function selectionDraft(
  request: ModelSettingsRequest,
  state: ModelPickerState,
  value: string,
): ModelPickerDraft {
  const draft = { ...state.draft };
  switch (state.step) {
    case "model": {
      if (request.model.kind === "fixed") return draft;
      draft.model = value;
      const capabilities = request.capabilitiesFor(value);
      if (capabilities !== undefined) {
        if (!capabilities.fastMode) draft.speed = "standard";
        if (
          draft.reasoning !== "default" &&
          (!capabilities.reasoning || !capabilities.reasoningLevels.includes(draft.reasoning))
        ) {
          draft.reasoning = "default";
        }
      }
      return draft;
    }
    case "speed":
      draft.speed = SPEED_OPTIONS.find((option) => option.value === value)!.value;
      return draft;
    case "reasoning":
      draft.reasoning = REASONING_OPTIONS.find((option) => option.value === value)!.value;
      return draft;
  }
}

function selectionResult(
  request: ModelSettingsRequest,
  draft: ModelPickerDraft,
): ModelSettingsResult {
  const result: ModelSettingsResult = {};
  if (
    request.model.kind === "pick" &&
    draft.model !== null &&
    draft.model !== request.model.current
  ) {
    result.model = draft.model;
  }
  if (request.settingsEditable) {
    if (draft.reasoning !== (request.reasoning ?? "default")) result.reasoning = draft.reasoning;
    const originalSpeed = request.serviceTier.kind === "priority" ? "priority" : "standard";
    if (
      !request.externalRouting &&
      request.serviceTier.kind !== "custom" &&
      draft.speed !== originalSpeed
    ) {
      result.serviceTier = draft.speed;
    }
  }
  return result;
}

export function transitionModelPicker(
  state: ModelPickerState,
  event: ModelPickerEvent,
  request: ModelSettingsRequest,
): ModelPickerTransition {
  if (event.type === "cancel") return { kind: "cancel" };
  if (event.type === "back") {
    const previous = state.history.at(-1);
    return previous === undefined
      ? { kind: "cancel" }
      : {
          kind: "render",
          state: { ...previous, draft: state.draft, history: state.history.slice(0, -1) },
        };
  }
  const options = stepOptions(request, state.draft, state.step);
  if (event.type !== "submit") {
    if (
      (state.step !== "model" || request.model.kind !== "pick") &&
      (event.type === "char" || event.type === "backspace")
    ) {
      return { kind: "render", state };
    }
    return {
      kind: "render",
      state: { ...state, select: reduceSelect(state.select, event, { options }) },
    };
  }
  const value = selectValueAtCursor(
    filterOptions(options, state.select.filter),
    state.select.cursor,
  );
  if (value === undefined) return { kind: "render", state };
  const draft = selectionDraft(request, state, value);
  const step = nextStep(request, draft, state.step);
  if (step === undefined) return { kind: "settle", result: selectionResult(request, draft) };
  return {
    kind: "render",
    state: {
      step,
      draft,
      select: initialSelectState({
        options: stepOptions(request, draft, step),
        defaultValue: draft[step],
      }),
      history: [...state.history, { step: state.step, select: state.select }],
    },
  };
}

export function modelPickerTitle(state: ModelPickerState): string {
  return { model: "Select model", speed: "Select speed", reasoning: "Select reasoning" }[
    state.step
  ];
}

export function renderModelPicker(
  request: ModelSettingsRequest,
  state: ModelPickerState,
  theme: Theme,
  width: number,
): string[] {
  const options = stepOptions(request, state.draft, state.step);
  const value = selectValueAtCursor(
    filterOptions(options, state.select.filter),
    state.select.cursor,
  );
  const draft = value === undefined ? state.draft : selectionDraft(request, state, value);
  const last = nextStep(request, draft, state.step) === undefined;
  const model =
    modelOptions(request).find((option) => option.value === state.draft.model)?.label ??
    state.draft.model;
  const context =
    state.step === "model"
      ? request.model.kind === "fixed"
        ? request.model.reason
        : undefined
      : [
          model,
          ...(state.step === "reasoning" && state.history.some((page) => page.step === "speed")
            ? [state.draft.speed === "priority" ? "Fast" : "Standard"]
            : []),
        ]
          .filter(Boolean)
          .join(" · ");
  return renderSelectQuestion(
    {
      kind: state.step === "model" && request.model.kind === "pick" ? "search" : "single",
      message: "",
      description: context,
      options,
      select: state.select,
      footerHints: [
        "↑/↓ move",
        last ? "Enter apply" : "Enter next",
        state.history.length > 0 ? "Esc/← back" : "Esc cancel",
      ],
    },
    theme,
    width,
  );
}

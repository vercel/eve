import type { PromptOption } from "./prompt-ui.js";
import { previousGraphemeBoundary } from "#shared/text-boundaries.js";

/**
 * Snapshot of the select interaction, advanced by {@link reduceSelect}. `cursor`
 * indexes the visible (filtered) list; `selected` holds the marked values for a
 * multi-select (a single-select reads the cursor's option at submit instead).
 */
export interface SelectState {
  filter: string;
  cursor: number;
  selected: Set<string>;
}

/** Keyboard intents the select reducer understands. */
export type SelectEvent =
  | { type: "char"; char: string }
  | { type: "backspace" }
  | { type: "up" }
  | { type: "down" }
  | { type: "toggle" };

/** Inputs that stay fixed across a single select session. */
export interface SelectContext {
  /** Selectable entries, including any disabled ones (the cursor skips them). */
  options: readonly PromptOption<string>[];
  /**
   * Appends a virtual Submit row after the visible options. The cursor can
   * land on it (index `visible.length`, see {@link submitRowIndex}) but it
   * carries no value: `toggle` ignores it and {@link selectValueAtCursor}
   * reads `undefined`. Multi-selects use it as the explicit confirm target.
   */
  submitRow?: boolean;
}

/** Cursor index of the virtual Submit row: one past the visible options. */
export function submitRowIndex(visible: readonly PromptOption<string>[]): number {
  return visible.length;
}

/**
 * Case-insensitive substring match across an option's label, value, and hints.
 * An empty query returns every option, so the cursor can always scroll the
 * full list; `featured` only shapes the searchable picker's default viewport,
 * not which rows exist.
 */
export function filterOptions(
  options: readonly PromptOption<string>[],
  filter: string,
): PromptOption<string>[] {
  const query = filter.trim().toLowerCase();
  if (query === "") return [...options];
  return options.filter(
    (option) =>
      option.label.toLowerCase().includes(query) ||
      option.value.toLowerCase().includes(query) ||
      (option.hint?.toLowerCase().includes(query) ?? false) ||
      (option.focusHint?.toLowerCase().includes(query) ?? false),
  );
}

/** A row the cursor can land on: neither disabled nor locked. */
function isFocusable(option: PromptOption<string>): boolean {
  return !option.disabled && !option.locked;
}

/** A focused row the user can select or toggle. */
function isActionable(option: PromptOption<string>): boolean {
  return isFocusable(option) && !option.completed;
}

/**
 * First focusable index in a visible list. Falls back to the Submit row when
 * every entry is non-interactive and one exists, otherwise to 0.
 */
function firstFocusableIndex(visible: readonly PromptOption<string>[], submitRow: boolean): number {
  const index = visible.findIndex(isFocusable);
  if (index >= 0) return index;
  return submitRow ? submitRowIndex(visible) : 0;
}

/**
 * Moves the cursor by `delta`, wrapping and skipping non-focusable entries.
 * With a Submit row, the index one past the options is part of the cycle.
 */
function stepCursor(
  visible: readonly PromptOption<string>[],
  cursor: number,
  delta: number,
  submitRow: boolean,
): number {
  const total = visible.length + (submitRow ? 1 : 0);
  if (total === 0) return cursor;
  let next = cursor;
  for (let i = 0; i < total; i += 1) {
    next = (next + delta + total) % total;
    if (submitRow && next === submitRowIndex(visible)) return next;
    const option = visible[next];
    if (option && isFocusable(option)) return next;
  }
  return cursor;
}

/**
 * Advances the interaction state for a single keypress.
 *
 * Editing the query (`char`/`backspace`) re-homes the cursor onto the first
 * selectable match but leaves marked values intact, so a multi-select keeps its
 * picks while the list is filtered. `toggle` (space) marks or unmarks the
 * highlighted entry; navigation skips disabled rows.
 */
export function reduceSelect(
  state: SelectState,
  event: SelectEvent,
  context: SelectContext,
): SelectState {
  const submitRow = context.submitRow === true;
  switch (event.type) {
    case "char": {
      const filter = state.filter + event.char;
      return {
        ...state,
        filter,
        cursor: firstFocusableIndex(filterOptions(context.options, filter), submitRow),
      };
    }
    case "backspace": {
      if (state.filter.length === 0) return state;
      const filter = state.filter.slice(
        0,
        previousGraphemeBoundary(state.filter, state.filter.length),
      );
      return {
        ...state,
        filter,
        cursor: firstFocusableIndex(filterOptions(context.options, filter), submitRow),
      };
    }
    case "up":
    case "down": {
      const visible = filterOptions(context.options, state.filter);
      const delta = event.type === "up" ? -1 : 1;
      const cursor = stepCursor(visible, state.cursor, delta, submitRow);
      return cursor === state.cursor ? state : { ...state, cursor };
    }
    case "toggle": {
      const option = filterOptions(context.options, state.filter)[state.cursor];
      if (option === undefined || !isActionable(option)) return state;
      const selected = new Set(state.selected);
      if (selected.has(option.value)) selected.delete(option.value);
      else selected.add(option.value);
      return { ...state, selected };
    }
  }
}

/**
 * Computes the starting state. The cursor lands on `defaultValue` when it
 * matches a focusable entry, otherwise on the first focusable entry.
 * `initialValues` seed a multi-select's marked set, as do any `locked` options:
 * locked rows are mandatory, so they start selected and the reducer refuses to
 * unmark them.
 */
export function initialSelectState(input: {
  options: readonly PromptOption<string>[];
  filter?: string;
  defaultValue?: string;
  initialValues?: readonly string[];
  submitRow?: boolean;
}): SelectState {
  const filter = input.filter ?? "";
  const visible = filterOptions(input.options, filter);
  let cursor = firstFocusableIndex(visible, input.submitRow === true);
  if (input.defaultValue !== undefined) {
    const index = visible.findIndex(
      (option) => isFocusable(option) && option.value === input.defaultValue,
    );
    if (index >= 0) cursor = index;
  }
  const lockedValues = input.options
    .filter((option) => option.locked)
    .map((option) => option.value);
  return { filter, cursor, selected: new Set([...(input.initialValues ?? []), ...lockedValues]) };
}

/** Value of the highlighted actionable entry, or `undefined` otherwise. */
export function selectValueAtCursor(
  visible: readonly PromptOption<string>[],
  cursor: number,
): string | undefined {
  const option = visible[cursor];
  return option && isActionable(option) ? option.value : undefined;
}

/** Marked values, ordered to match the option list rather than toggle order. */
export function orderedSelection(
  options: readonly PromptOption<string>[],
  selected: ReadonlySet<string>,
): string[] {
  return options.filter((option) => selected.has(option.value)).map((option) => option.value);
}

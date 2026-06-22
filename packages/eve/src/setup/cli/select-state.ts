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

/** A virtual row appended to local matches for a non-empty type-ahead query. */
export interface SearchActionOption {
  label(query: string): string;
}

const SEARCH_ACTION_PREFIX = "\0search-action:";

/** Encodes the query behind a virtual search action for picker transport. */
export function searchActionValue(query: string): string {
  return `${SEARCH_ACTION_PREFIX}${query}`;
}

/** Reads a query from a virtual search action value. */
export function searchActionQuery(value: string): string | undefined {
  return value.startsWith(SEARCH_ACTION_PREFIX)
    ? value.slice(SEARCH_ACTION_PREFIX.length)
    : undefined;
}

/** Keyboard intents the select reducer understands. */
export type SelectEvent =
  | { type: "char"; char: string }
  | { type: "backspace" }
  | { type: "clear" }
  | { type: "up" }
  | { type: "down" }
  | { type: "toggle" };

/** Inputs that stay fixed across a single select session. */
export interface SelectContext {
  /** Selectable entries, including any disabled ones (the cursor skips them). */
  options: readonly PromptOption<string>[];
  /** Optional virtual row appended to local matches for a non-empty query. */
  searchAction?: SearchActionOption;
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
  searchAction?: SearchActionOption,
): PromptOption<string>[] {
  const query = filter.trim();
  if (query === "") return [...options];
  const normalizedQuery = query.toLowerCase();
  const matches = options.filter(
    (option) =>
      option.label.toLowerCase().includes(normalizedQuery) ||
      option.value.toLowerCase().includes(normalizedQuery) ||
      (option.hint?.toLowerCase().includes(normalizedQuery) ?? false) ||
      (option.focusHint?.toLowerCase().includes(normalizedQuery) ?? false),
  );
  if (searchAction === undefined) return matches;
  return [...matches, { value: searchActionValue(query), label: searchAction.label(query) }];
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
        cursor: firstFocusableIndex(
          filterOptions(context.options, filter, context.searchAction),
          submitRow,
        ),
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
        cursor: firstFocusableIndex(
          filterOptions(context.options, filter, context.searchAction),
          submitRow,
        ),
      };
    }
    case "clear": {
      if (state.filter.length === 0) return state;
      const filter = "";
      return {
        ...state,
        filter,
        cursor: firstFocusableIndex(
          filterOptions(context.options, filter, context.searchAction),
          submitRow,
        ),
      };
    }
    case "up":
    case "down": {
      const visible = filterOptions(context.options, state.filter, context.searchAction);
      const delta = event.type === "up" ? -1 : 1;
      const cursor = stepCursor(visible, state.cursor, delta, submitRow);
      return cursor === state.cursor ? state : { ...state, cursor };
    }
    case "toggle": {
      const option = filterOptions(context.options, state.filter, context.searchAction)[
        state.cursor
      ];
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
  searchAction?: SearchActionOption;
  submitRow?: boolean;
}): SelectState {
  const filter = input.filter ?? "";
  const visible = filterOptions(input.options, filter, input.searchAction);
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

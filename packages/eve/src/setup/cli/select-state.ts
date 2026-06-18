import type { PromptOption } from "./prompt-ui.js";

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

/** Virtual row appended after the filtered options. */
export type SelectTrailingRow = "submit" | "query-action";

/** Inputs that stay fixed across a single select session. */
export interface SelectContext {
  /** Selectable entries, including any disabled ones (the cursor skips them). */
  options: readonly PromptOption<string>[];
  /**
   * Appends a virtual row after the visible options. Submit is always present;
   * query-action is present only for a nonblank filter.
   */
  trailingRow?: SelectTrailingRow;
}

/** Cursor index of a virtual trailing row: one past the visible options. */
export function trailingRowIndex(visible: readonly PromptOption<string>[]): number {
  return visible.length;
}

export type SelectCursorRow =
  | { readonly kind: "option"; readonly option: PromptOption<string> }
  | { readonly kind: "submit" }
  | { readonly kind: "query-action"; readonly query: string };

function activeTrailingRow(
  trailingRow: SelectTrailingRow | undefined,
  filter: string,
): SelectTrailingRow | undefined {
  if (trailingRow !== "query-action") return trailingRow;
  return filter.trim().length > 0 ? trailingRow : undefined;
}

/** Row addressed by the cursor after filtering and virtual-row expansion. */
export function selectCursorRow(
  state: SelectState,
  context: SelectContext,
): SelectCursorRow | undefined {
  const visible = filterOptions(context.options, state.filter);
  const option = visible[state.cursor];
  if (option !== undefined) return { kind: "option", option };
  if (state.cursor !== trailingRowIndex(visible)) return undefined;

  switch (activeTrailingRow(context.trailingRow, state.filter)) {
    case "submit":
      return { kind: "submit" };
    case "query-action":
      return { kind: "query-action", query: state.filter.trim() };
    case undefined:
      return undefined;
  }
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
function firstFocusableIndex(
  visible: readonly PromptOption<string>[],
  trailingRow: SelectTrailingRow | undefined,
  filter: string,
): number {
  const index = visible.findIndex(isFocusable);
  if (index >= 0) return index;
  return activeTrailingRow(trailingRow, filter) === undefined ? 0 : trailingRowIndex(visible);
}

/**
 * Moves the cursor by `delta`, wrapping and skipping non-focusable entries.
 * With a Submit row, the index one past the options is part of the cycle.
 */
function stepCursor(
  visible: readonly PromptOption<string>[],
  cursor: number,
  delta: number,
  trailingRow: SelectTrailingRow | undefined,
  filter: string,
): number {
  const hasTrailingRow = activeTrailingRow(trailingRow, filter) !== undefined;
  const total = visible.length + (hasTrailingRow ? 1 : 0);
  if (total === 0) return cursor;
  let next = cursor;
  for (let i = 0; i < total; i += 1) {
    next = (next + delta + total) % total;
    if (hasTrailingRow && next === trailingRowIndex(visible)) return next;
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
  switch (event.type) {
    case "char": {
      const filter = state.filter + event.char;
      return {
        ...state,
        filter,
        cursor: firstFocusableIndex(
          filterOptions(context.options, filter),
          context.trailingRow,
          filter,
        ),
      };
    }
    case "backspace": {
      if (state.filter.length === 0) return state;
      const filter = state.filter.slice(0, -1);
      return {
        ...state,
        filter,
        cursor: firstFocusableIndex(
          filterOptions(context.options, filter),
          context.trailingRow,
          filter,
        ),
      };
    }
    case "up":
    case "down": {
      const visible = filterOptions(context.options, state.filter);
      const delta = event.type === "up" ? -1 : 1;
      const cursor = stepCursor(visible, state.cursor, delta, context.trailingRow, state.filter);
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
  trailingRow?: SelectTrailingRow;
}): SelectState {
  const filter = input.filter ?? "";
  const visible = filterOptions(input.options, filter);
  let cursor = firstFocusableIndex(visible, input.trailingRow, filter);
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

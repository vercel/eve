import type { PromptOption } from "./prompt-ui.js";
import { previousGraphemeBoundary } from "#shared/text-boundaries.js";

export interface SelectState {
  filter: string;
  cursor: number;
  selected: Set<string>;
}

export interface SearchActionOption {
  label(query: string): string;
}

const SEARCH_ACTION_PREFIX = "\0search-action:";

export function searchActionValue(query: string): string {
  return `${SEARCH_ACTION_PREFIX}${query}`;
}

export function searchActionQuery(value: string): string | undefined {
  return value.startsWith(SEARCH_ACTION_PREFIX)
    ? value.slice(SEARCH_ACTION_PREFIX.length)
    : undefined;
}

export type SelectEvent =
  | { type: "char"; char: string }
  | { type: "backspace" }
  | { type: "delete-word-backward" }
  | { type: "clear" }
  | { type: "up" }
  | { type: "down" }
  | { type: "toggle" };

export interface SelectContext {
  options: readonly PromptOption<string>[];
  searchAction?: SearchActionOption;
  submitRow?: boolean;
}

export function submitRowIndex(visible: readonly PromptOption<string>[]): number {
  return visible.length;
}

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
      option.trailingAction !== true &&
      (option.label.toLowerCase().includes(normalizedQuery) ||
        option.value.toLowerCase().includes(normalizedQuery) ||
        (option.hint?.toLowerCase().includes(normalizedQuery) ?? false) ||
        (option.focusHint?.toLowerCase().includes(normalizedQuery) ?? false) ||
        (option.keywords?.some((keyword) => keyword.toLowerCase().includes(normalizedQuery)) ??
          false)),
  );
  if (searchAction !== undefined) {
    matches.push({ value: searchActionValue(query), label: searchAction.label(query) });
  }
  return [...matches, ...options.filter((option) => option.trailingAction === true)];
}

function isFocusable(option: PromptOption<string>): boolean {
  return !option.disabled && !option.locked;
}

function isActionable(option: PromptOption<string>): boolean {
  return isFocusable(option) && !option.completed;
}

function previousWordBoundary(text: string): number {
  let cursor = text.length;
  while (cursor > 0) {
    const previous = previousGraphemeBoundary(text, cursor);
    if (isWordCharacter(text.slice(previous, cursor))) break;
    cursor = previous;
  }
  while (cursor > 0) {
    const previous = previousGraphemeBoundary(text, cursor);
    if (!isWordCharacter(text.slice(previous, cursor))) break;
    cursor = previous;
  }
  return cursor;
}

function isWordCharacter(text: string): boolean {
  return /^[\p{L}\p{M}\p{N}_]/u.test(text);
}

function firstFocusableIndex(visible: readonly PromptOption<string>[], submitRow: boolean): number {
  const index = visible.findIndex(isFocusable);
  if (index >= 0) return index;
  return submitRow ? submitRowIndex(visible) : 0;
}

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
    case "delete-word-backward": {
      if (state.filter.length === 0) return state;
      const filter = state.filter.slice(0, previousWordBoundary(state.filter));
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

export function selectValueAtCursor(
  visible: readonly PromptOption<string>[],
  cursor: number,
): string | undefined {
  const option = visible[cursor];
  return option && isActionable(option) ? option.value : undefined;
}

export function orderedSelection(
  options: readonly PromptOption<string>[],
  selected: ReadonlySet<string>,
): string[] {
  return options.filter((option) => selected.has(option.value)).map((option) => option.value);
}

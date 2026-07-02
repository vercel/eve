/**
 * Pure state and rendering for the prompt's slash-command typeahead: the
 * filtered suggestion list shown above the input while the draft looks like
 * the start of a command. The renderer owns keys and lifecycle; this module
 * owns which commands match, which row is highlighted, and what the rows
 * look like — so the whole interaction is unit-testable without a TTY.
 */

import type { PromptCommandSpec } from "./prompt-commands.js";
import { sliceVisible, visibleLength } from "./terminal-text.js";
import type { Theme } from "./theme.js";
import { renderCursorRow } from "#setup/cli/option-row.js";

/**
 * The typeahead keeps the list scannable; extra matches window around the
 * cursor. Sized to hold the full command registry so a bare `/` never scrolls
 * a command (e.g. `/exit`) out of view — windowing is for longer future lists.
 * Keep this >= the number of entries in `PROMPT_COMMANDS`.
 */
const MAX_VISIBLE_SUGGESTIONS = 10;

export interface CommandTypeaheadState {
  /** The prompt text the matches were derived from. */
  readonly query: string;
  readonly matches: readonly PromptCommandSpec[];
  readonly selectedIndex: number;
  /** Esc pressed; the list stays hidden until the query text changes. */
  readonly dismissed: boolean;
}

/**
 * Derives the typeahead for `text`, carrying the highlight and dismissal
 * over from `previous`. Commands match while the draft is a lone `/`-token
 * (no whitespace yet) prefixing a name or alias; an exact match stays in the
 * list so the highlight confirms what Enter will run. The previous highlight
 * survives narrowing by identity, not index; dismissal survives only while
 * the text is unchanged, so caret moves keep it and any edit reopens.
 */
export function typeaheadFor(
  commands: readonly PromptCommandSpec[],
  text: string,
  previous?: CommandTypeaheadState,
): CommandTypeaheadState {
  const matches = matchingCommands(commands, text);
  const carried = previous === undefined ? undefined : previous.matches[previous.selectedIndex];
  const carriedIndex = carried === undefined ? -1 : matches.indexOf(carried);
  return {
    query: text,
    matches,
    selectedIndex: carriedIndex >= 0 ? carriedIndex : 0,
    dismissed: previous !== undefined && previous.dismissed && previous.query === text,
  };
}

function matchingCommands(
  commands: readonly PromptCommandSpec[],
  text: string,
): readonly PromptCommandSpec[] {
  if (!text.startsWith("/") || /\s/.test(text)) return [];
  const rest = text.slice(1);
  return commands.filter((spec) =>
    [spec.name, ...spec.aliases].some((token) => token.startsWith(rest)),
  );
}

/** True when the list should render and own the up/down/tab/enter keys. */
export function isTypeaheadOpen(state: CommandTypeaheadState): boolean {
  return state.matches.length > 0 && !state.dismissed;
}

/** Moves the highlight one row, wrapping at both ends. */
export function moveTypeaheadSelection(
  state: CommandTypeaheadState,
  delta: 1 | -1,
): CommandTypeaheadState {
  const count = state.matches.length;
  if (count === 0) return state;
  const selectedIndex = (state.selectedIndex + delta + count) % count;
  return { ...state, selectedIndex };
}

/** Hides the list until the input text changes. */
export function dismissTypeahead(state: CommandTypeaheadState): CommandTypeaheadState {
  return state.dismissed ? state : { ...state, dismissed: true };
}

/** The highlighted command, when the list has one. */
export function selectedTypeaheadCommand(
  state: CommandTypeaheadState,
): PromptCommandSpec | undefined {
  return state.matches[state.selectedIndex];
}

/**
 * The editor text accepting `spec` produces: the canonical invocation, plus
 * a trailing space when the command takes an argument so the caret lands
 * ready for typing it.
 */
export function typeaheadCompletion(spec: PromptCommandSpec): string {
  return `/${spec.name}${spec.takesArgument ? " " : ""}`;
}

/**
 * When the draft is a complete command name or alias with exactly one match,
 * the dropdown collapses into an inline hint trailing the prompt row. Returns
 * the command's argument shape to paint dim after the input — an empty string
 * for argument-less commands, which still collapse the list — or `undefined`
 * when the list should render normally (partial draft, multiple matches, or a
 * dismissed list).
 */
export function inlineCommandHint(state: CommandTypeaheadState): string | undefined {
  if (state.dismissed || state.matches.length !== 1) return undefined;
  const spec = state.matches[0]!;
  const typed = state.query.startsWith("/") ? state.query.slice(1) : state.query;
  if (![spec.name, ...spec.aliases].includes(typed)) return undefined;
  return spec.argumentHint ?? "";
}

/**
 * Paints the suggestion rows (the select-question grammar): the highlight
 * carries the cursor glyph and inverse-blue name, every row shows its aliases and
 * description dim, and overflow windows around the highlight. The argument
 * hint is held back for the inline exact-match view ({@link inlineCommandHint})
 * — it only earns space once a single command is committed to.
 */
export function renderCommandSuggestions(
  state: CommandTypeaheadState,
  theme: Theme,
  width: number,
): string[] {
  const c = theme.colors;
  const count = state.matches.length;
  const viewSize = Math.min(count, MAX_VISIBLE_SUGGESTIONS);
  const start = Math.max(
    0,
    Math.min(state.selectedIndex - Math.floor(viewSize / 2), count - viewSize),
  );
  const end = Math.min(start + viewSize, count);

  const visible = state.matches.slice(start, end);
  const invocation = (spec: PromptCommandSpec): string => {
    const aliases = spec.aliases.map((alias) => ` (/${alias})`).join("");
    return `/${spec.name}${aliases}`;
  };
  const column = Math.max(...visible.map((spec) => invocation(spec).length)) + 2;

  const rows = visible.map((spec, offset) => {
    const isCursor = start + offset === state.selectedIndex;
    const name = `/${spec.name}`;
    const content = isCursor ? `${theme.glyph.selectedPointer} ${name}` : `  ${name}`;
    const selection = renderCursorRow(content, isCursor, c);
    let detail = invocation(spec).slice(`/${spec.name}`.length);
    let pad = " ".repeat(column - invocation(spec).length);
    // The selected label's trailing inverse cell replaces the first suffix
    // space so aliases and descriptions stay in the same columns.
    if (isCursor) {
      if (detail.startsWith(" ")) detail = detail.slice(1);
      else pad = pad.slice(1);
    }
    return `${selection}${c.dim(detail)}${pad}${c.dim(spec.description)}`;
  });

  return rows.map((row) => (visibleLength(row) > width ? sliceVisible(row, width) : row));
}

import type { PromptCommandSpec } from "./prompt-commands.js";
import { PROMPT_COMMANDS } from "./prompt-commands.js";
import { sliceVisible, visibleLength } from "#cli/ui/terminal-text.js";
import type { Theme } from "./theme.js";
import { renderCursorRow } from "#setup/cli/option-row.js";

const MAX_VISIBLE_SUGGESTIONS = PROMPT_COMMANDS.length;

export interface CommandTypeaheadState {
  readonly query: string;
  readonly matches: readonly PromptCommandSpec[];
  readonly selectedIndex: number;
  readonly dismissed: boolean;
}

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

export function isTypeaheadOpen(state: CommandTypeaheadState): boolean {
  return state.matches.length > 0 && !state.dismissed;
}

export function moveTypeaheadSelection(
  state: CommandTypeaheadState,
  delta: 1 | -1,
): CommandTypeaheadState {
  const count = state.matches.length;
  if (count === 0) return state;
  const selectedIndex = (state.selectedIndex + delta + count) % count;
  return { ...state, selectedIndex };
}

export function dismissTypeahead(state: CommandTypeaheadState): CommandTypeaheadState {
  return state.dismissed ? state : { ...state, dismissed: true };
}

export function selectedTypeaheadCommand(
  state: CommandTypeaheadState,
): PromptCommandSpec | undefined {
  return state.matches[state.selectedIndex];
}

export function typeaheadCompletion(spec: PromptCommandSpec): string {
  return `/${spec.name}${spec.takesArgument ? " " : ""}`;
}

export function inlineCommandHint(state: CommandTypeaheadState): string | undefined {
  if (state.dismissed || state.matches.length !== 1) return undefined;
  const spec = state.matches[0]!;
  const typed = state.query.startsWith("/") ? state.query.slice(1) : state.query;
  if (![spec.name, ...spec.aliases].includes(typed)) return undefined;
  return spec.argumentHint ?? "";
}

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
    const detail = invocation(spec).slice(`/${spec.name}`.length);
    const pad = " ".repeat(column - invocation(spec).length);
    return `${selection}${c.dim(detail)}${pad}${c.dim(spec.description)}`;
  });

  return rows.map((row) => (visibleLength(row) > width ? sliceVisible(row, width) : row));
}

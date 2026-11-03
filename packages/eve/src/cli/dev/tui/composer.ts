import {
  clipVisible,
  renderInputText,
  renderInputWithBlockCursor,
  stripTerminalControls,
} from "#cli/ui/terminal-text.js";

import {
  argumentTypeaheadCompletion,
  argumentTypeaheadFor,
  argumentTypeaheadLoadingLabel,
  argumentTypeaheadQuery,
  moveArgumentTypeaheadSelection,
  renderArgumentSuggestions,
  selectedArgumentSuggestion,
  type ArgumentTypeaheadState,
  type PromptArgumentSuggestion,
} from "./argument-typeahead.js";
import {
  dismissTypeahead,
  inlineCommandHint,
  isTypeaheadOpen,
  moveTypeaheadSelection,
  renderCommandSuggestions,
  selectedTypeaheadCommand,
  typeaheadCompletion,
  typeaheadFor,
  type CommandTypeaheadState,
} from "./command-typeahead.js";
import {
  EMPTY_LINE,
  KillRing,
  PromptHistory,
  deleteForward,
  layoutPromptInput,
  lineOf,
  movePromptLine,
  visibleLine,
  type LineState,
} from "./line-editor.js";
import {
  isPromptControlCommand,
  parsePromptCommand,
  promptCommandSpec,
  type ArgumentTypeaheadCommand,
  type PromptCommandSpec,
} from "./prompt-commands.js";
import type { AgentTUIInput } from "./runner.js";
import { stripPromptControlCharacters, type TerminalKey } from "./stream-format.js";
import type { Theme } from "./theme.js";

/** How long a catalog load may run before the drawer says it is loading. */
const catalogLoadingDelayMs = 500;

/** Commands whose argument drawer opens as soon as they are completed from the command list. */
const ARGUMENT_DRAWER_COMMANDS = new Set(["add", "login", "loglevel", "model"]);

interface ComposerHost {
  readonly theme: Theme;
  readonly commands: readonly PromptCommandSpec[];
  readonly argumentSuggestions?: (
    command: ArgumentTypeaheadCommand,
  ) => Promise<readonly PromptArgumentSuggestion[]>;
  readonly killRing: KillRing;
  /** Whether a turn is running, so Enter steers and Esc/Ctrl+C cancel. */
  working(): boolean;
  emit(input: AgentTUIInput): void;
  /** Echoes a slash command so its outcome has an invocation to hang under. */
  echoCommand(text: string): void;
  /** The user sent a chat message. */
  sentMessage(): void;
  exit(): void;
  cycleLogs(): void;
  repaint(): void;
}

/**
 * The always-open message editor at the bottom of the TUI. It keeps its
 * draft for the whole session: other surfaces take the keyboard on top of it
 * and hand it back untouched.
 */
export class Composer {
  readonly #host: ComposerHost;
  #editor: LineState = EMPTY_LINE;
  readonly #history = new PromptHistory();
  #typeahead?: CommandTypeaheadState;
  #argumentTypeahead?: ArgumentTypeaheadState;
  readonly #catalogs = new Map<
    ArgumentTypeaheadCommand,
    | { kind: "loading"; since: number }
    | { kind: "ready"; suggestions: readonly PromptArgumentSuggestion[] }
  >();
  /** Set by a cancel key while a turn runs; a second Ctrl+C stops following it. */
  cancelRequested = false;
  /** True after one Ctrl+C at an idle prompt; the next exits. */
  exitArmed = false;

  constructor(host: ComposerHost) {
    this.#host = host;
    this.#history.begin("");
  }

  get text(): string {
    return this.#editor.text;
  }

  /** Replaces the draft, e.g. with `--input` or a message handed back by a cancelled turn. */
  setText(text: string): void {
    this.#apply(lineOf(stripPromptControlCharacters(text)));
  }

  /** Whether an argument catalog is loading, so the drawer's loading row can appear on time. */
  loading(): boolean {
    const query = argumentTypeaheadQuery(this.#editor.text);
    return query !== undefined && this.#catalogs.get(query.command)?.kind === "loading";
  }

  key(key: TerminalKey): void {
    if (key.type !== "ctrl-c") this.exitArmed = false;
    const edited = this.#host.killRing.apply(this.#editor, key, { multiline: true });
    if (edited !== undefined) {
      this.#apply(edited);
      return;
    }
    const working = this.#host.working();
    switch (key.type) {
      case "up":
      case "ctrl-p":
        this.#move(-1);
        return;
      case "down":
      case "ctrl-n":
        this.#move(1);
        return;
      case "tab": {
        const argument = this.#openArgumentTypeahead();
        const selected = argument === undefined ? undefined : selectedArgumentSuggestion(argument);
        if (argument !== undefined && selected !== undefined) {
          this.#apply(lineOf(argumentTypeaheadCompletion(argument, selected)));
          return;
        }
        const command = this.#highlightedCommand();
        if (command !== undefined) this.#apply(lineOf(typeaheadCompletion(command)));
        return;
      }
      case "escape": {
        if (this.#argumentTypeahead !== undefined) {
          this.#argumentTypeahead = undefined;
          return;
        }
        const open = this.#openCommandTypeahead();
        if (open !== undefined) {
          this.#typeahead = dismissTypeahead(open);
          return;
        }
        if (working && !this.cancelRequested) this.#cancel();
        return;
      }
      case "enter":
        this.#enter(working);
        return;
      case "ctrl-d":
        // EOF on an empty line quits; otherwise it forward-deletes.
        if (this.#editor.text.length === 0) this.#host.exit();
        else this.#apply(deleteForward(this.#editor));
        return;
      case "ctrl-l":
        this.#host.cycleLogs();
        return;
      case "ctrl-c":
        if (working) {
          if (!this.cancelRequested) {
            this.#cancel();
            return;
          }
          // Once cancellation is pending, Ctrl+C is the hard escape hatch.
          this.cancelRequested = false;
          this.exitArmed = true;
          this.#host.emit({ type: "interrupt" });
          return;
        }
        if (this.exitArmed) {
          this.#host.exit();
          return;
        }
        this.exitArmed = true;
        this.#apply(EMPTY_LINE);
        return;
      default:
        return;
    }
  }

  #cancel(): void {
    this.cancelRequested = true;
    this.#host.emit({ type: "cancel" });
  }

  #move(delta: -1 | 1): void {
    const argument = this.#openArgumentTypeahead();
    if (argument !== undefined) {
      this.#argumentTypeahead = moveArgumentTypeaheadSelection(argument, delta);
      return;
    }
    const command = this.#openCommandTypeahead();
    if (command !== undefined) {
      this.#typeahead = moveTypeaheadSelection(command, delta);
      return;
    }
    // Within a multi-line draft, the arrows walk rows; only at an edge do they recall history.
    const moved = movePromptLine(this.#editor, delta < 0 ? "up" : "down");
    if (moved !== undefined) {
      this.#apply(moved);
      return;
    }
    const entry = delta < 0 ? this.#history.previous(this.#editor.text) : this.#history.next();
    if (entry !== undefined) this.#apply(lineOf(entry));
  }

  #enter(working: boolean): void {
    const argument = this.#openArgumentTypeahead();
    const argumentSelected =
      argument === undefined ? undefined : selectedArgumentSuggestion(argument);
    const command = this.#highlightedCommand();
    // Complete only genuine prefixes: a draft that already parses submits verbatim.
    if (
      argument !== undefined &&
      argumentSelected?.next !== undefined &&
      argument.completed.length === 0
    ) {
      this.#apply(lineOf(`${argumentTypeaheadCompletion(argument, argumentSelected)} `));
      return;
    }
    if (
      argument === undefined &&
      command !== undefined &&
      this.#host.argumentSuggestions !== undefined &&
      ARGUMENT_DRAWER_COMMANDS.has(command.name)
    ) {
      this.#apply(lineOf(typeaheadCompletion(command)));
      return;
    }
    const prompt =
      argument !== undefined && argumentSelected !== undefined
        ? argumentTypeaheadCompletion(argument, argumentSelected)
        : command !== undefined && parsePromptCommand(this.#editor.text) === null
          ? typeaheadCompletion(command).trimEnd()
          : this.#editor.text;
    if (prompt.trim().length === 0) return;
    if (promptCommandSpec(prompt)?.spec.history !== "omit") this.#history.add(prompt);
    this.#apply(EMPTY_LINE);
    this.#history.begin("");
    if (isPromptControlCommand(prompt)) {
      this.#host.echoCommand(stripTerminalControls(prompt.trim()));
      if (working && parsePromptCommand(prompt)?.type === "cancel") this.cancelRequested = true;
    } else {
      this.#host.sentMessage();
    }
    this.#host.emit({ type: "submit", text: prompt });
  }

  #apply(next: LineState): void {
    this.#editor = next;
    this.#syncTypeahead();
  }

  #openCommandTypeahead(): CommandTypeaheadState | undefined {
    return this.#typeahead !== undefined && isTypeaheadOpen(this.#typeahead)
      ? this.#typeahead
      : undefined;
  }

  #openArgumentTypeahead(): ArgumentTypeaheadState | undefined {
    return this.#argumentTypeahead?.suggestions.length ? this.#argumentTypeahead : undefined;
  }

  #highlightedCommand(): PromptCommandSpec | undefined {
    const open = this.#openCommandTypeahead();
    return open === undefined ? undefined : selectedTypeaheadCommand(open);
  }

  #syncTypeahead(): void {
    const text = this.#editor.text;
    this.#typeahead = typeaheadFor(this.#host.commands, text, this.#typeahead);
    const query = argumentTypeaheadQuery(text);
    const load = this.#host.argumentSuggestions;
    if (query === undefined || load === undefined) {
      this.#argumentTypeahead = undefined;
      return;
    }
    const catalog = this.#catalogs.get(query.command);
    if (catalog === undefined) {
      const command = query.command;
      this.#catalogs.set(command, { kind: "loading", since: Date.now() });
      void load(command)
        .catch(() => [])
        .then((suggestions) => {
          this.#catalogs.set(command, { kind: "ready", suggestions });
          this.#syncTypeahead();
          this.#host.repaint();
        });
    }
    this.#argumentTypeahead =
      catalog?.kind === "ready"
        ? argumentTypeaheadFor(query, catalog.suggestions, this.#argumentTypeahead)
        : undefined;
  }

  /** The menu rows beneath the prompt: argument or command suggestions. */
  drawerRows(width: number): string[] {
    const theme = this.#host.theme;
    const query = argumentTypeaheadQuery(this.#editor.text);
    const catalog = query === undefined ? undefined : this.#catalogs.get(query.command);
    if (catalog?.kind === "loading" && query !== undefined) {
      if (Date.now() - catalog.since < catalogLoadingDelayMs) return [];
      return [
        clipVisible(
          theme.colors.dim(`Loading ${argumentTypeaheadLoadingLabel(query.command)}…`),
          width,
        ),
      ];
    }
    if (this.#argumentTypeahead !== undefined) {
      return renderArgumentSuggestions(this.#argumentTypeahead, theme, width);
    }
    const open = this.#openCommandTypeahead();
    return open === undefined ? [] : renderCommandSuggestions(open, theme, width);
  }

  /** The prompt rows, windowed to `maxRows`, with `placeholder` behind an empty draft. */
  promptRows(input: {
    readonly width: number;
    readonly maxRows: number;
    readonly caretVisible: boolean;
    readonly placeholder: string;
  }): string[] {
    const hint = this.#typeahead === undefined ? undefined : inlineCommandHint(this.#typeahead);
    return promptInputRows({
      ...input,
      ...this.#editor,
      theme: this.#host.theme,
      ghost: hint === undefined ? "" : this.#host.theme.colors.dim(` ${hint}`),
    });
  }
}

interface PromptInputRowsInput {
  readonly text: string;
  readonly cursor: number;
  readonly width: number;
  readonly theme: Theme;
  readonly caretVisible: boolean;
  /** Dim text trailing the caret on a single-line draft, such as a command's argument hint. */
  readonly ghost: string;
  readonly maxRows: number;
  /** Shown dim behind the caret while the draft is empty. */
  readonly placeholder?: string;
}

/**
 * Renders a draft as terminal rows. A draft can carry newlines from paste or
 * Shift+Enter, so it renders one row per line and windows tall input to
 * `maxRows`, marking hidden rows with an ellipsis.
 */
export function promptInputRows(input: PromptInputRowsInput): string[] {
  const { text, cursor, width, theme, caretVisible, ghost, maxRows, placeholder } = input;
  const c = theme.colors;
  // Reserve the gutter and the block cursor's trailing cell at end-of-line.
  const budget = Math.max(1, width - 3);
  if (text.length === 0 && placeholder !== undefined) {
    const body = renderInputWithBlockCursor({
      ...visibleLine({ text: placeholder, cursor: 0 }, budget, theme.glyph.ellipsis),
      visible: caretVisible,
      inverse: c.inverse,
      render: (segment) => c.dim(renderInputText(segment)),
    });
    return [clipVisible(`${theme.glyph.prompt} ${body}`, width)];
  }

  const layout = layoutPromptInput({ text, cursor });
  const visibleCount = Math.min(Math.max(1, maxRows), layout.rows.length);
  const top = Math.max(
    0,
    Math.min(layout.caretRow - visibleCount + 1, layout.rows.length - visibleCount),
  );
  const promptGlyph = text.startsWith("/") ? theme.glyph.user : theme.glyph.prompt;
  const ellipsis = c.dim(theme.glyph.ellipsis);
  const rows: string[] = [];
  for (let r = top; r < top + visibleCount; r += 1) {
    const row = layout.rows[r]!;
    let gutter = r === 0 ? promptGlyph : " ";
    if (r === top && top > 0) gutter = ellipsis;
    else if (r === top + visibleCount - 1 && top + visibleCount < layout.rows.length) {
      gutter = ellipsis;
    }
    let body = renderInputText(row.text);
    if (r === layout.caretRow) {
      // Window the active row so the caret stays visible on long lines.
      body = renderInputWithBlockCursor({
        ...visibleLine(
          { text: row.text, cursor: layout.caretOffset },
          budget,
          theme.glyph.ellipsis,
        ),
        visible: caretVisible,
        inverse: c.inverse,
        render: renderInputText,
      });
      if (ghost.length > 0 && layout.rows.length === 1) body += ghost;
    }
    rows.push(clipVisible(`${gutter} ${body}`, width));
  }
  return rows;
}

import { isCancel, Prompt, settings, type State, TextPrompt } from "@clack/core";
import {
  cornerFor,
  formatPromptCancellation,
  formatPromptHeader,
  formatPromptOpener,
  formatPromptOutro,
  formatPromptSubmission,
  formatRailLine,
  railFor,
  runSelectComponent,
  type ChannelSetupAwaitChoice,
  type PromptState,
} from "#setup/cli/index.js";
import { createRailLog, type RailSpinner } from "#setup/cli/index.js";
import pc from "picocolors";

import {
  initialQuitGuardState,
  quitHintNote,
  reduceQuitGuard,
  type QuitGuardState,
} from "./quit-guard.js";
import { WizardCancelledError } from "./step.js";

/**
 * Clack constrains option values to readonly primitives. Our scaffold flow
 * only ever uses string-valued options (`ChannelKind`, `SetupMode`,
 * `ProviderConnection`, model id), so the tightened bound matches usage.
 */
export type PrompterValue = string | number | boolean;

export interface SelectOption<T extends PrompterValue> {
  value: T;
  label: string;
  hint?: string;
  /** Short inline annotation shown dimmed only while the cursor is on this row. */
  focusHint?: string;
  /**
   * Longer, display-only explanation shown dimmed alongside the option while it
   * is highlighted during navigation. Hidden once a choice is submitted.
   */
  description?: string;
  /** Cursor-pointer/active-label accent; "warning" turns them yellow for an attention row. */
  accent?: "warning";
  disabled?: boolean;
  /** Parenthetical shown after a disabled option's label explaining why. */
  disabledReason?: string;
  /**
   * "warning" renders the disabled reason in yellow with a dimmed (not struck)
   * label: the row is unavailable here but actionable elsewhere (e.g. a channel
   * that needs a Vercel account points at /model), unlike the default disabled
   * styling, which marks a hard conflict.
   */
  disabledReasonTone?: "warning";
  /**
   * Completed work: renders with a check and remains cursor-addressable for
   * contextual feedback, but cannot be selected or toggled.
   */
  completed?: boolean;
  /**
   * Marks a mandatory row that is always selected and cannot be toggled off; the
   * cursor skips it and it renders a dimmed check. Mutually exclusive with
   * `disabled`.
   */
  locked?: boolean;
  /** Parenthetical shown after a locked option's label, e.g. "always available". */
  lockedReason?: string;
  /**
   * A leading run of featured options forms a searchable picker's default
   * viewport: with no filter typed, only they are in view, and scrolling or
   * filtering reaches the rest of the list. Featured options must be sorted
   * to the front. Meaningless without `search`.
   */
  featured?: boolean;
}

/**
 * An outcome line from an earlier lap of a looping menu, shown with the
 * repainted question: the TUI panel renders it beneath the options, the CLI
 * prints it to scrollback before the prompt.
 */
export interface SelectNotice {
  tone: "success" | "info" | "warning" | "error";
  text: string;
}

/** Options common to every {@link Prompter.select} call. */
export interface SelectCommonOptions<T extends PrompterValue> {
  message: string;
  options: SelectOption<T>[];
  /**
   * Add a type-ahead filter line. The filter is a case-insensitive substring
   * match against each option's label, value, and hint.
   */
  search?: boolean;
  /** Placeholder shown in the filter line while it is empty (with `search`). */
  placeholder?: string;
  /**
   * Require a selection before enter can confirm. For multi-select this blocks
   * an empty submission; single-select always resolves to the highlighted row,
   * so it is inherently satisfied.
   */
  required?: boolean;
  /**
   * How option hints are laid out in the dev TUI panel (the CLI prompter ignores
   * it and keeps its default inline, unnumbered rendering). "stacked" renders
   * each hint on its own line below the label with a blank line between options —
   * for small action menus whose hints carry current values. "inline" keeps hints
   * on the label row, suppresses numeric shortcuts, and separates the trailing
   * completion action (e.g. the `/channels` task list).
   */
  hintLayout?: "stacked" | "inline";
  /** Outcome lines from earlier laps of a looping menu. */
  notices?: readonly SelectNotice[];
}

/** A selectable action appended after local matches for a non-empty query. */
export interface SearchAction<T extends PrompterValue> {
  label(query: string): string;
  value(query: string): T;
  /**
   * Loads replacement rows without closing a repainting picker. Plain CLI
   * prompts still return {@link value}; the TUI keeps the search input open
   * and shows the wait beside it.
   */
  load?(query: string): Promise<readonly SelectOption<T>[]>;
}

/** Single-select form: navigate, then enter picks the highlighted option. */
export interface SingleSelectOptions<T extends PrompterValue> extends SelectCommonOptions<T> {
  multiple?: false;
  /** Pre-position the cursor on the option whose value matches. */
  initialValue?: T;
  /** Appended after local matches for each non-empty query. Requires `search: true`. */
  searchAction?: SearchAction<T>;
}

/** Multi-select form: space or enter toggles rows; enter on the trailing Submit row confirms the marked set. */
export interface MultiSelectOptions<T extends PrompterValue> extends SelectCommonOptions<T> {
  multiple: true;
  /** Pre-mark these values as selected. */
  initialValues?: T[];
}

/** Result of a single-select whose one row can be edited inline. */
export type EditableSelectResult<T extends PrompterValue> =
  | { kind: "selected"; value: T }
  | { kind: "edited"; value: T; text: string };

/** Inline-edit behavior for one row in an otherwise ordinary single-select. */
export interface EditableSelectOptions<T extends PrompterValue> extends SingleSelectOptions<T> {
  editable: {
    value: T;
    defaultValue: string;
    formatHint: (value: string) => string;
    validate?: (value: string) => string | undefined;
  };
}

/** Color intent for {@link Prompter.note}: red warning (default) or green success. */
export type NoteTone = "warning" | "success";

/** Input for {@link Prompter.acknowledge}: a heading plus optional body lines. */
export interface AcknowledgeOptions {
  message: string;
  lines?: readonly string[];
}

export interface Prompter {
  text(opts: {
    message: string;
    placeholder?: string;
    defaultValue?: string;
    validate?: (value: string) => string | undefined;
    /**
     * Context lines shown with the question (e.g. why it is being re-asked).
     * They live and die with the question: the TUI paints them inside the
     * question panel so they vanish on submit, the CLI prints them to
     * scrollback above the prompt.
     */
    notices?: readonly SelectNotice[];
  }): Promise<string>;

  password(opts: {
    message: string;
    validate?: (value: string) => string | undefined;
  }): Promise<string>;

  /**
   * Unified picker. Defaults to single-select (enter picks the highlighted row);
   * pass `multiple: true` for a checklist (space or enter toggles, enter on
   * the trailing Submit row confirms). Add
   * `search: true` for a type-ahead filter. `required` gates an empty
   * multi-select submission.
   */
  select<T extends PrompterValue>(opts: SingleSelectOptions<T>): Promise<T>;
  select<T extends PrompterValue>(opts: MultiSelectOptions<T>): Promise<T[]>;
  /**
   * TUI enhancement for a select row whose secondary value becomes an inline
   * editor while focused. Typing and editing keys update it directly. Optional
   * so non-repainting prompt implementations can keep the ordinary
   * select-then-text fallback.
   */
  selectEditable?<T extends PrompterValue>(
    opts: EditableSelectOptions<T>,
  ): Promise<EditableSelectResult<T>>;

  /**
   * Static instructions the user dismisses before the flow moves on. The TUI
   * renders them in the question slot of the flow panel (the text takes the
   * place of option rows) until enter; the CLI prints them to scrollback and
   * resolves immediately, since printed text persists there. Optional so
   * lightweight test fakes can omit it — flows fall back to {@link note}.
   */
  acknowledge?(opts: AcknowledgeOptions): Promise<void>;

  /**
   * Presents actions while a setup operation continues in the background.
   * The TUI implements it; plain and headless prompters omit it, so callers
   * fall back to waiting without concurrent controls.
   */
  awaitChoice?: ChannelSetupAwaitChoice;

  /**
   * Rail-attached notice, no bullet — reads as a follow-up to the previous
   * step. Red by default (warnings, collisions); pass `tone: "success"` for a
   * green closing note like the one-shot next steps.
   */
  note(message: string, title?: string, options?: { tone?: NoteTone }): void;

  /** Prints the Vercel ▲ logo + title + subtitle banner. */
  intro(title: string, subtitle?: string): void;

  /** Prints a final green ● end-cap with the message. */
  outro(message: string): void;

  log: {
    message(text: string): void;
    info(text: string): void;
    success(text: string): void;
    warning(text: string): void;
    error(text: string): void;
    commandOutput(text: string): void;
    section?(title: string, lines: readonly string[]): void;
    /**
     * Starts a section-like braille spinner for a network or other async wait,
     * returning a handle whose `stop()` clears it. Present on the real prompter;
     * optional so lightweight test fakes can omit it.
     */
    spinner?(message: string): RailSpinner;
  };
}

const DEFAULT_INTRO_SUBTITLE = "Production-grade agent framework.";

function guardCancel<T>(value: T | symbol): T {
  if (isCancel(value)) {
    process.stdout.write(formatPromptCancellation("Setup cancelled.", pc));
    throw new WizardCancelledError();
  }
  return value as T;
}

let escapeCancelDisabled = false;

/**
 * Removes clack's built-in `escape → cancel` alias so a lone Escape no longer
 * quits on its own; {@link attachQuitGuard} then drives a two-press
 * confirmation. Ctrl-C keeps its own alias and still cancels on the first press.
 * Idempotent and process-global, which is safe because every setup prompt
 * is built here and routes through {@link attachQuitGuard}.
 */
function disableEscapeCancel(): void {
  if (escapeCancelDisabled) return;
  settings.aliases.delete("escape");
  escapeCancelDisabled = true;
}

/** A prompt's live quit-guard view, read during render to show the quit hint. */
interface QuitGuard {
  /** Corner-line status note while armed, otherwise `undefined`. */
  note(): string | undefined;
}

/**
 * Wires two-stage Escape-to-quit onto a clack prompt. The first Escape arms a
 * quit hint (surfaced via {@link QuitGuard.note} during render); the second
 * flips the prompt into clack's `cancel` state, which clack's own keypress tail
 * then finalizes, renders, and closes. Any other key disarms.
 *
 * Depends on {@link disableEscapeCancel} having removed the escape alias, so the
 * first Escape reaches this handler instead of cancelling the prompt outright.
 */
function attachQuitGuard<T>(prompt: Prompt<T>): QuitGuard {
  let state: QuitGuardState = initialQuitGuardState;
  prompt.on("key", (_char, info) => {
    const { state: next, action } = reduceQuitGuard(
      state,
      info?.name === "escape" ? { type: "escape" } : { type: "other-key" },
    );
    state = next;
    if (action === "quit") {
      prompt.state = "cancel";
    }
  });
  return { note: () => quitHintNote(state, pc) };
}

function toPromptState(state: State): PromptState {
  return state;
}

function railForState(state: State): string {
  return railFor(toPromptState(state), pc);
}

function cornerForState(state: State): string {
  return cornerFor(toPromptState(state), pc);
}

/**
 * Builds the shared two-line prompt header (leader rail + bullet + message).
 * The leader rail is white above the very first prompt (matching the logo
 * column) and green thereafter (matching the previous submitted step).
 */
function header(state: State, message: string, resolvedCount: number): string {
  return formatPromptHeader(toPromptState(state), message, {
    colors: pc,
    leadingRail: resolvedCount === 0 ? "white" : "green",
  });
}

const REDACTED_DISPLAY = "••••••••";

function textPrompt(
  resolvedCount: number,
  opts: {
    message: string;
    placeholder?: string;
    defaultValue?: string;
    mask?: boolean;
    validate?: (value: string) => string | undefined;
  },
): Promise<string | symbol | undefined> {
  let quitGuard: QuitGuard | undefined;
  const prompt = new TextPrompt({
    validate: opts.validate ? (value) => opts.validate?.(value ?? "") : undefined,
    placeholder: opts.placeholder,
    defaultValue: opts.defaultValue,
    render() {
      const head = header(this.state, opts.message, resolvedCount);
      const placeholderRendered = opts.placeholder
        ? pc.inverse(opts.placeholder[0]) + pc.dim(opts.placeholder.slice(1))
        : pc.inverse(pc.hidden("_"));
      const maskedBody = this.value ? "•".repeat(this.value.length) : placeholderRendered;
      let body = placeholderRendered;
      if (opts.mask) {
        body = maskedBody;
      } else if (this.value) {
        body = this.userInputWithCursor;
      }

      switch (this.state) {
        case "error":
          return `${head.trim()}\n${railForState(this.state)}  ${body}\n${cornerForState(this.state)}  ${pc.red(this.error)}\n`;
        case "submit": {
          let display = this.value || opts.placeholder || "";
          if (opts.mask) {
            display = this.value ? REDACTED_DISPLAY : (opts.placeholder ?? "");
          }
          return formatPromptSubmission(this.state, opts.message, display, {
            colors: pc,
            leadingRail: resolvedCount === 0 ? "white" : "green",
          });
        }
        case "cancel":
          return `${head}${railForState(this.state)}  ${pc.strikethrough(pc.dim(opts.mask && this.value ? REDACTED_DISPLAY : (this.value ?? "")))}${
            this.value?.trim() ? `\n${railForState(this.state)}` : ""
          }`;
        default:
          return `${head}${railForState(this.state)}  ${body}\n${cornerForState(this.state)}${cornerNote(quitGuard?.note())}\n`;
      }
    },
  });
  quitGuard = attachQuitGuard(prompt);
  return prompt.prompt();
}

/** Tucks the quit hint onto an inline corner line, mirroring the error layout. */
function cornerNote(note: string | undefined): string {
  return note ? `  ${note}` : "";
}

/**
 * Builds a prompter with Vercel-branded styling — white-then-green vertical
 * rails, open/filled triangle bullets per step, and a colored corner
 * below the active prompt. Built on `@clack/core` so we own every glyph.
 *
 * The resolved-prompt count is scoped to the returned prompter so the
 * first prompt's leader rail is white and subsequent ones are green.
 */
export function createPrompter(): Prompter {
  disableEscapeCancel();
  let resolvedCount = 0;
  const log = createRailLog({ colors: pc, output: process.stdout });

  // Printed text persists in CLI scrollback, so question notices land there
  // (a repainting loop re-prints its question anyway).
  function printNotices(notices: readonly SelectNotice[] | undefined): void {
    for (const notice of notices ?? []) {
      if (notice.tone === "success") log.success(notice.text);
      else if (notice.tone === "warning") log.warning(notice.text);
      else if (notice.tone === "error") log.error(notice.text);
      else log.message(notice.text);
    }
  }

  return {
    async text(opts) {
      log.settle();
      printNotices(opts.notices);
      const result = guardCancel(await textPrompt(resolvedCount, opts));
      resolvedCount += 1;
      return result ?? "";
    },

    async password(opts) {
      log.settle();
      const result = guardCancel(
        await textPrompt(resolvedCount, {
          message: opts.message,
          mask: true,
          validate: opts.validate,
        }),
      );
      resolvedCount += 1;
      return result ?? "";
    },

    async select<T extends PrompterValue>(
      opts: SingleSelectOptions<T> | MultiSelectOptions<T>,
    ): Promise<T | T[]> {
      log.settle();
      printNotices(opts.notices);
      const result = guardCancel(
        await runSelectComponent<T>({
          message: opts.message,
          options: opts.options,
          multiple: opts.multiple === true,
          search: opts.search ?? false,
          searchAction: opts.multiple === true ? undefined : opts.searchAction,
          required: opts.required ?? false,
          placeholder: opts.placeholder,
          defaultValue: opts.multiple === true ? undefined : opts.initialValue,
          initialValues: opts.multiple === true ? opts.initialValues : undefined,
          leadingRail: resolvedCount === 0 ? "white" : "green",
          attachGuard: (prompt) => attachQuitGuard(prompt),
        }),
      );
      resolvedCount += 1;
      return result;
    },

    async acknowledge(opts) {
      // Printed text persists in CLI scrollback, so there is nothing to hold
      // open — render and resolve.
      log.settle();
      process.stdout.write(formatRailLine(pc.bold(opts.message), pc, process.stdout));
      for (const line of opts.lines ?? []) {
        process.stdout.write(formatRailLine(pc.dim(line), pc, process.stdout));
      }
    },

    note(message, title, options) {
      log.settle();
      const paint = options?.tone === "success" ? pc.green : pc.red;
      if (title) process.stdout.write(formatRailLine(paint(pc.bold(title)), pc, process.stdout));
      process.stdout.write(formatRailLine(paint(message), pc, process.stdout));
    },

    intro(title, subtitle = DEFAULT_INTRO_SUBTITLE) {
      log.settle();
      process.stdout.write(formatPromptOpener(title, subtitle, pc));
    },

    outro(message) {
      log.settle();
      process.stdout.write(formatPromptOutro(message, pc));
    },

    log,
  };
}

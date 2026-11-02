import { stripTerminalControls } from "#cli/ui/terminal-text.js";
import type { ProviderPickerChoice, ProviderPickerRequest } from "#setup/flows/provider.js";
import type { PlannerNavigation } from "#setup/prompter.js";
import {
  initialSelectState,
  orderedSelection,
  reduceSelect,
  searchActionQuery,
  selectValueAtCursor,
  type SelectState,
} from "#setup/cli/select-state.js";
import { toErrorMessage } from "#shared/errors.js";

import type { Block } from "./blocks.js";
import { renderFlowDrawer } from "./flow-drawer.js";
import { applyLineEditorKey, lineOf, type KillRing, type LineState } from "./line-editor.js";
import {
  initialProviderPickerState,
  transitionProviderPicker,
  type ProviderPickerEvent,
} from "./provider-picker.js";
import {
  enterBadge,
  renderAcknowledgeQuestion,
  renderSelectQuestion,
  renderTextQuestion,
  type FlowPanelContent,
  type FlowPanelLine,
  type FlowPanelStatus,
  type SetupPanelOption,
  type SetupSelectPanelState,
} from "./setup-panel.js";
import type {
  SetupEditableSelectResult,
  SetupFlowInterrupt,
  SetupFlowRenderer,
  SetupSelectRequest,
  SetupSelectResult,
} from "./setup-flow.js";
import { reduceSetupSelectInput, setupSelectionIntent } from "./setup-selection-input.js";
import { formatTurnDuration } from "./stream-format.js";
import type { AskSurface, Settle, Surface } from "./surface.js";
import type { Theme } from "./theme.js";

/** What the setup flow needs from the TUI that hosts it. */
export interface SetupFlowHost {
  readonly theme: Theme;
  readonly killRing: KillRing;
  readonly ask: AskSurface;
  /** Takes a surface off the stack without settling it. */
  drop(surface: Surface): void;
  paint(): void;
  requestExit(): void;
  caretVisible(): boolean;
  spinnerFrame(): string;
  pulse(startedAtMs: number): string;
  /** Adds a block to the transcript. */
  commit(block: Block): void;
  /** Shows a setup status above the prompt while no flow is open. */
  setFlowlessStatus(text: string | undefined): void;
  /** Hands the terminal to a child process that inherits stdio. */
  suspend<T>(task: () => Promise<T>): Promise<T>;
}

type SetupFlowState = {
  title: string;
  navigation?: PlannerNavigation;
  /** When the flow's pulse started, so its blink stays on a steady beat. */
  startedAtMs: number;
  lines: FlowPanelLine[];
  summary?: { headline: string; facts: readonly { label: string; value: string }[] };
  status?: { text: string; startedAtMs: number };
  /** Latest subprocess output line; replaced per write, never persisted. */
  preview?: string;
  /** Recent subprocess output, pulled in as evidence when a warning settles it. */
  outputBuffer: string[];
  questionTitle?: string;
  /** First line produced after the previous task-list question settled. */
  taskListLineStart?: number;
  /** Task-list questions render their latest outcomes inside the question. */
  hideLinesWhileQuestion?: boolean;
};

/** How much subprocess output a warning or error can pull in as its evidence. */
const FLOW_OUTPUT_BUFFER_CAP = 40;

/**
 * A setup command's flow: its progress lines, status, and questions, drawn in
 * a drawer that replaces the composer until the flow ends. Questions are
 * surfaces on the TUI's stack, so they own the keyboard while they are open.
 */
export class SetupFlowView {
  readonly #host: SetupFlowHost;
  #flow?: SetupFlowState;

  readonly renderer: SetupFlowRenderer = {
    begin: (title) => this.#beginFlow(title),
    setNavigation: (navigation) => this.#updateFlow((flow) => (flow.navigation = navigation)),
    end: (options) => this.#endFlow(options?.preserveDiagnostics ?? true),
    readSelect: (options) => this.#readSetupSelect(options),
    readEditableSelect: (options) => this.#readSetupEditableSelect(options),
    readProviderPicker: (options) => this.#readProviderPicker(options),
    readText: (options) => this.#readSetupText(options),
    readAcknowledge: (options) => this.#readSetupAcknowledge(options),
    readChoice: (options) => this.#readSetupChoice(options),
    setStatus: (text) => this.#setFlowStatus(text),
    renderLine: (text, tone) => this.#renderFlowLine(text, tone),
    replaceContent: (content) => this.#replaceFlowContent(content),
    renderOutput: (text) => this.#renderFlowOutput(text),
    withInheritedStdio: (task) => this.#host.suspend(task),
    withExclusiveTerminal: (task) => this.#host.suspend(task),
    waitForInterrupt: (options) => this.#waitForFlowInterrupt(options),
  };

  constructor(host: SetupFlowHost) {
    this.#host = host;
  }

  get open(): boolean {
    return this.#flow !== undefined;
  }

  /** Opens the setup flow; until it ends, its lines, questions, and status replace the composer. */
  #beginFlow(title: string): void {
    this.#flow = {
      title: stripTerminalControls(title),
      startedAtMs: Date.now(),
      lines: [],
      outputBuffer: [],
    };
    this.#host.paint();
  }

  #updateFlow(update: (flow: SetupFlowState) => void): void {
    if (this.#flow === undefined) return;
    update(this.#flow);
    this.#host.paint();
  }

  /**
   * Closes the flow, optionally keeping its warnings and errors. A
   * diagnostic's pulled-in subprocess output persists with it, as one dim
   * block directly above: a failed command must keep its evidence.
   */
  #endFlow(preserveDiagnostics: boolean): void {
    const flow = this.#flow;
    if (flow === undefined) return;
    this.#flow = undefined;
    if (preserveDiagnostics) {
      let evidence: string[] = [];
      for (const line of flow.lines) {
        if (line.evidence === true) {
          evidence.push(line.text);
          continue;
        }
        if (line.tone === "warning" || line.tone === "error") {
          if (evidence.length > 0) {
            this.#host.commit({
              kind: "flow",
              title: "info",
              body: evidence.join("\n"),
              live: false,
            });
          }
          this.#host.commit({ kind: "flow", title: line.tone, body: line.text, live: false });
        }
        evidence = [];
      }
    }
    this.#host.paint();
  }

  #requireFlow(): SetupFlowState {
    if (this.#flow === undefined) throw new Error("A setup question needs an open setup flow.");
    return this.#flow;
  }

  /**
   * Asks one setup question inside the flow. Ctrl+C both cancels the question
   * and asks the TUI to exit; closing the TUI cancels it.
   */
  #askSetup<T>(
    title: string,
    make: (settle: Settle<T>, flow: SetupFlowState) => Omit<Surface, "placement">,
    cancelled: T,
  ): Promise<T> {
    const flow = this.#requireFlow();
    flow.questionTitle = stripTerminalControls(title);
    // A question means the preceding background operation settled.
    if (flow.status !== undefined) {
      flow.status = undefined;
      flow.summary = undefined;
      flow.preview = undefined;
    }
    return this.#host.ask<T>(
      (settle) => {
        const surface = make(settle, flow);
        return {
          ...surface,
          placement: "flow",
          key: (key) => {
            if (key.type === "ctrl-c") this.#host.requestExit();
            surface.key(key);
          },
          dispose: () => {
            surface.dispose?.();
            flow.questionTitle = undefined;
            flow.hideLinesWhileQuestion = false;
          },
        };
      },
      () => cancelled,
    );
  }

  /**
   * One select question. Behavior comes from the shared select reducer
   * (filter, cursor, toggle, locked rows, the multi-select Submit row).
   * Resolves the chosen values, or `undefined` on cancel.
   */
  #readSetupSelect(opts: SetupSelectRequest): Promise<SetupSelectResult> {
    const multiple = opts.kind === "multi" || opts.kind === "searchable-multi";
    const searchAction = opts.kind === "search" ? opts.searchAction : undefined;
    const searchableField = opts.kind === "search" && opts.layout === undefined;
    const planner = opts.navigation?.kind === "planner" ? opts.navigation : undefined;
    const submitRow = multiple && planner === undefined;
    let options: readonly SetupPanelOption[] = opts.options;
    const initial: Parameters<typeof initialSelectState>[0] = { options, searchAction, submitRow };
    if ("initialValue" in opts && opts.initialValue !== undefined) {
      initial.defaultValue = opts.initialValue;
    }
    if ("initialValues" in opts && opts.initialValues !== undefined) {
      initial.initialValues = opts.initialValues;
    }
    let select: SelectState = initialSelectState(initial);
    let error: string | undefined;
    let loading = false;
    let searchVersion = 0;

    return this.#askSetup<SetupSelectResult>(
      opts.message,
      (settle, flow) => {
        let notices = opts.notices;
        if (opts.kind === "task-list" || (opts.kind === "search" && opts.layout === "task-list")) {
          const start = flow.taskListLineStart ?? flow.lines.length;
          notices =
            opts.notices ??
            flow.lines
              .slice(start)
              .filter(
                (line): line is FlowPanelLine & { tone: "success" | "warning" | "error" } =>
                  line.tone === "success" || line.tone === "warning" || line.tone === "error",
              )
              .map((line) => ({ tone: line.tone, text: line.text }));
          flow.taskListLineStart = flow.lines.length;
          flow.hideLinesWhileQuestion = true;
        }
        const loadSearch = async (
          query: string,
          load: (query: string) => Promise<readonly SetupPanelOption[]>,
        ) => {
          loading = true;
          error = undefined;
          const version = ++searchVersion;
          try {
            const loaded = await load(query);
            if (version !== searchVersion) return;
            options = loaded;
            select = {
              ...initialSelectState({ options, searchAction, submitRow }),
              filter: select.filter,
            };
          } catch (reason) {
            if (version === searchVersion) error = toErrorMessage(reason);
          } finally {
            if (version === searchVersion) {
              loading = false;
              this.#host.paint();
            }
          }
        };
        const close = (value: SetupSelectResult) => {
          searchVersion += 1;
          settle.done(value);
        };
        return {
          caret: () => searchableField,
          rows: (width) => {
            const state: Exclude<SetupSelectPanelState, { kind: "actions" }> = {
              ...opts,
              message: "",
              options,
              select,
            };
            if (notices !== undefined && notices.length > 0) state.notices = notices;
            if (error !== undefined) state.error = error;
            if (loading) state.loadingFrame = this.#host.spinnerFrame();
            if (searchableField) state.caretVisible = this.#host.caretVisible();
            return renderSelectQuestion(state, this.#host.theme, width);
          },
          key: (key) => {
            if (loading) {
              if (key.type === "ctrl-c") close(undefined);
              else if (key.type === "escape") {
                searchVersion += 1;
                loading = false;
                select = reduceSelect(
                  select,
                  { type: "clear" },
                  { options, searchAction, submitRow },
                );
              }
              return;
            }
            const first = planner?.firstNavigableStep ?? 0;
            const direction =
              planner !== undefined && key.type === "left" && planner.activeStep > first
                ? "back"
                : planner !== undefined &&
                    key.type === "right" &&
                    planner.activeStep >= first &&
                    planner.activeStep < planner.steps.length - 1
                  ? "forward"
                  : undefined;
            if (direction !== undefined) {
              close({
                kind: "navigate",
                direction,
                values: multiple ? orderedSelection(options, select.selected) : [],
              });
              return;
            }
            const base = { key, options, searchAction, select };
            const result = multiple
              ? reduceSetupSelectInput({
                  ...base,
                  kind: opts.kind,
                  required: opts.required,
                  plannerNavigation: planner !== undefined || undefined,
                })
              : reduceSetupSelectInput({ ...base, kind: opts.kind });
            switch (result.kind) {
              case "cancel":
                close(undefined);
                return;
              case "update":
                select = result.select;
                error = undefined;
                return;
              case "submit": {
                const query = searchActionQuery(result.values[0] ?? "");
                const load = searchAction?.load;
                if (query === undefined || load === undefined) close(result.values);
                else void loadSearch(query, load);
                return;
              }
              case "error":
                error = result.message;
                return;
              default:
                return;
            }
          },
        };
      },
      undefined,
    );
  }

  /**
   * An inert context row and an action menu beside the live flow status.
   * Returns at once with a `close()` so the caller can dismiss it when a
   * concurrent wait wins.
   */
  #readSetupChoice(
    opts: Parameters<SetupFlowRenderer["readChoice"]>[0],
  ): ReturnType<SetupFlowRenderer["readChoice"]> {
    const flow = this.#requireFlow();
    flow.status = { text: stripTerminalControls(opts.status), startedAtMs: Date.now() };
    // Nothing is preselected, so Enter cannot fire "Try again" by reflex.
    let cursor: number | undefined;
    let close!: () => void;
    const choice = this.#host.ask<string | undefined>(
      (settle) => {
        close = () => settle.done(undefined);
        return {
          placement: "flow",
          rows: (width) =>
            renderSelectQuestion(
              { kind: "actions", context: opts.context, actions: opts.actions, cursor },
              this.#host.theme,
              width,
            ),
          key: (key) => {
            if (key.type === "ctrl-c") this.#host.requestExit();
            const intent = setupSelectionIntent(key, { textNavigation: true });
            if (intent?.kind === "cancel") settle.done(undefined);
            else if (intent?.kind === "move") {
              const count = opts.actions.length;
              if (count === 0) return;
              const delta = intent.direction === "down" ? 1 : -1;
              cursor =
                cursor === undefined
                  ? intent.direction === "down"
                    ? 0
                    : count - 1
                  : (cursor + delta + count) % count;
            } else if (intent?.kind === "submit" && cursor !== undefined) {
              settle.done(opts.actions[cursor]!.value);
            }
          },
          dispose: () => {
            flow.status = undefined;
          },
        };
      },
      () => undefined,
    );
    return { choice, close: () => close() };
  }

  #readSetupEditableSelect(
    opts: Parameters<SetupFlowRenderer["readEditableSelect"]>[0],
  ): Promise<SetupEditableSelectResult | undefined> {
    const initial: Parameters<typeof initialSelectState>[0] = { options: opts.options };
    if (opts.initialValue !== undefined) initial.defaultValue = opts.initialValue;
    let select = initialSelectState(initial);
    let editor = lineOf("");
    let error: string | undefined;
    // Hovering the editable row makes it a live field, empty until typing starts.
    const onEditableRow = () =>
      selectValueAtCursor([...opts.options], select.cursor) === opts.editable.value;

    return this.#askSetup<SetupEditableSelectResult | undefined>(
      opts.message,
      (settle) => ({
        caret: onEditableRow,
        rows: (width) => {
          const state: SetupSelectPanelState = {
            kind: "inline-edit",
            layout: "task-list",
            message: "",
            options: opts.options,
            select,
            edit: {
              optionValue: opts.editable.value,
              caretVisible: this.#host.caretVisible(),
              editor: {
                kind: "rename",
                editor,
                defaultValue: opts.editable.defaultValue,
                formatHint: opts.editable.formatHint,
              },
            },
          };
          if (error !== undefined) state.error = error;
          return renderSelectQuestion(state, this.#host.theme, width);
        },
        key: (key) => {
          const intent = setupSelectionIntent(key, { textNavigation: !onEditableRow() });
          if (intent?.kind === "cancel") {
            settle.done(undefined);
            return;
          }
          if (intent?.kind === "move") {
            select = reduceSelect(select, { type: intent.direction }, { options: opts.options });
            error = undefined;
            if (!onEditableRow()) editor = lineOf("");
            return;
          }
          if (intent?.kind === "submit") {
            const value = selectValueAtCursor([...opts.options], select.cursor);
            if (value === undefined) return;
            if (value !== opts.editable.value) {
              settle.done({ kind: "selected", value });
              return;
            }
            const text = (editor.text || opts.editable.defaultValue).trim();
            error = opts.editable.validate?.(text);
            if (error !== undefined) return;
            settle.done(
              text === opts.editable.defaultValue
                ? { kind: "selected", value }
                : { kind: "edited", value, text },
            );
            return;
          }
          if (!onEditableRow()) return;
          const edited = this.#host.killRing.apply(editor, key);
          if (edited !== undefined) {
            editor = edited;
            error = undefined;
          }
        },
      }),
      undefined,
    );
  }

  #readProviderPicker(opts: ProviderPickerRequest): Promise<ProviderPickerChoice | undefined> {
    this.#host.killRing.clear();
    let interaction = initialProviderPickerState(opts.options, opts.initialValue);
    let validation: AbortController | undefined;
    const editing = () =>
      interaction.phase.kind === "editing" || interaction.phase.kind === "invalid";

    return this.#askSetup<ProviderPickerChoice | undefined>(
      opts.message,
      (settle) => {
        const dispatch = (event: ProviderPickerEvent) => {
          const transition = transitionProviderPicker(interaction, event, opts.options);
          switch (transition.kind) {
            case "ignore":
              return;
            case "cancel":
              settle.done(undefined);
              return;
            case "settle":
              settle.done(transition.result);
              return;
            case "clear":
              validation?.abort();
              validation = undefined;
              interaction = transition.state;
              return;
            case "render":
              interaction = transition.state;
              return;
            case "validate": {
              interaction = transition.state;
              const controller = new AbortController();
              validation = controller;
              let result: ReturnType<typeof opts.validateInlineKey>;
              try {
                result = opts.validateInlineKey(transition.key, controller.signal);
              } catch (error) {
                settle.fail(error);
                return;
              }
              void result.then(
                (outcome) => {
                  if (validation !== controller || controller.signal.aborted) return;
                  validation = undefined;
                  dispatch({ type: "validated", validation: outcome });
                  this.#host.paint();
                },
                (error: unknown) => {
                  if (validation !== controller || controller.signal.aborted) return;
                  validation = undefined;
                  settle.fail(error);
                },
              );
              return;
            }
          }
        };
        return {
          caret: editing,
          rows: (width) => {
            // The cursor row's Enter affordance: `↵ change` on the active provider.
            let badge: string | undefined;
            if (interaction.phase.kind === "inactive") {
              const value = selectValueAtCursor([...opts.options], interaction.select.cursor);
              const row = opts.options.find((option) => option.value === value);
              if (row !== undefined) {
                badge = enterBadge(this.#host.theme, row.checked === true ? "change" : undefined);
              }
            }
            const panel: SetupSelectPanelState = {
              kind: "inline-edit",
              layout: "stacked",
              message: "",
              options: opts.options,
              select: interaction.select,
              edit: {
                optionValue: "ai-gateway-key",
                caretVisible: this.#host.caretVisible(),
                editor: { kind: "key", phase: interaction.phase },
              },
            };
            if (badge !== undefined) panel.cursorBadge = badge;
            return renderSelectQuestion(panel, this.#host.theme, width);
          },
          key: (key) => {
            const intent = setupSelectionIntent(key, {
              textNavigation: interaction.phase.kind === "inactive",
            });
            if (intent?.kind === "cancel") dispatch({ type: "cancel" });
            else if (intent?.kind === "move")
              dispatch({ type: "move", direction: intent.direction });
            else if (intent?.kind === "submit") dispatch({ type: "submit" });
            else if (editing() && "editor" in interaction.phase) {
              // Provider credentials must never enter the session kill ring.
              const edited = applyLineEditorKey(interaction.phase.editor, key);
              if (edited !== undefined) dispatch({ type: "edit", editor: edited });
            }
          },
          dispose: () => {
            validation?.abort();
            validation = undefined;
          },
        };
      },
      undefined,
    );
  }

  /**
   * One text question. `mask` renders bullets; `validate` keeps the prompt
   * open with its message. Resolves the value (the default when empty), or
   * `undefined` on cancel.
   */
  #readSetupText(opts: Parameters<SetupFlowRenderer["readText"]>[0]): Promise<string | undefined> {
    if (opts.mask === true) this.#host.killRing.clear();
    let editor: LineState = lineOf("");
    let error: string | undefined;
    return this.#askSetup<string | undefined>(
      opts.message,
      (settle) => ({
        caret: () => true,
        rows: (width) => {
          const state: Parameters<typeof renderTextQuestion>[0] = {
            message: "",
            editor,
            mask: opts.mask === true,
          };
          const placeholder = opts.placeholder ?? opts.defaultValue;
          if (placeholder !== undefined) state.placeholder = placeholder;
          if (opts.notices !== undefined) state.notices = opts.notices;
          if (error !== undefined) state.error = error;
          return renderTextQuestion(state, this.#host.theme, width, this.#host.caretVisible());
        },
        key: (key) => {
          const edited = opts.mask
            ? applyLineEditorKey(editor, key)
            : this.#host.killRing.apply(editor, key);
          if (edited !== undefined) {
            editor = edited;
            error = undefined;
          } else if (key.type === "ctrl-c" || key.type === "escape") {
            settle.done(undefined);
          } else if (key.type === "enter") {
            const value = editor.text.length > 0 ? editor.text : (opts.defaultValue ?? "");
            error = opts.validate?.(value);
            if (error === undefined) settle.done(value);
          }
        },
      }),
      undefined,
    );
  }

  /** Static instructions held in the flow until Enter or Esc. */
  #readSetupAcknowledge(opts: { message: string; lines: readonly string[] }): Promise<void> {
    return this.#askSetup<void>(
      opts.message,
      (settle) => ({
        rows: (width) =>
          renderAcknowledgeQuestion({ message: "", lines: opts.lines }, this.#host.theme, width),
        key: (key) => {
          if (key.type === "enter" || key.type === "escape" || key.type === "ctrl-c") settle.done();
        },
      }),
      undefined,
    );
  }

  /** See {@link SetupFlowRenderer.waitForInterrupt}: a key trap under the flow's questions. */
  #waitForFlowInterrupt(options?: { interruptible?: boolean }): {
    promise: Promise<SetupFlowInterrupt>;
    dispose(): void;
  } {
    const interruptible = options?.interruptible ?? true;
    let dispose!: () => void;
    const promise = this.#host.ask<SetupFlowInterrupt>(
      (settle) => {
        const surface: Surface = {
          key: (key) => {
            if (!interruptible || (key.type !== "ctrl-c" && key.type !== "escape")) return;
            if (key.type === "ctrl-c") this.#host.requestExit();
            settle.done(key.type === "ctrl-c" ? "ctrl-c" : "escape");
          },
        };
        // Disposal pops the trap without settling, so the promise never resolves.
        dispose = () => this.#host.drop(surface);
        return surface;
      },
      () => "ctrl-c",
    );
    return { promise, dispose: () => dispose() };
  }

  /**
   * The flow's one-line loading state; `undefined` clears it. With no flow
   * open it shows above the prompt instead.
   */
  #setFlowStatus(status: string | undefined): void {
    const text = status === undefined ? undefined : stripTerminalControls(status);
    if (this.#flow !== undefined) {
      this.#flow.status = text === undefined ? undefined : { text, startedAtMs: Date.now() };
      if (text === undefined) this.#flow.preview = undefined;
    } else {
      this.#host.setFlowlessStatus(text);
    }
    this.#host.paint();
  }

  /** Records one flow line; outside a flow it commits to the transcript. */
  #renderFlowLine(text: string, tone: "info" | "success" | "warning" | "error"): void {
    const content = stripTerminalControls(text);
    if (content.trim().length === 0) return;
    const flow = this.#flow;
    if (flow === undefined) {
      this.#host.commit({ kind: "flow", title: tone, body: content, live: false });
      this.#host.paint();
      return;
    }
    // A line settles the output preview; a warning or error first pulls the
    // buffered subprocess output in as its evidence.
    flow.preview = undefined;
    if (tone === "warning" || tone === "error") {
      for (const buffered of flow.outputBuffer) {
        flow.lines.push({ text: buffered, tone: "info", evidence: true });
      }
    }
    flow.outputBuffer = [];
    flow.lines.push({ text: content, tone });
    this.#host.paint();
  }

  #replaceFlowContent(content?: {
    headline: string;
    facts: readonly { label: string; value: string }[];
  }): void {
    this.#updateFlow((flow) => {
      flow.lines = [];
      flow.outputBuffer = [];
      flow.preview = undefined;
      flow.status = undefined;
      flow.summary =
        content === undefined
          ? undefined
          : {
              headline: stripTerminalControls(content.headline),
              facts: content.facts.map((fact) => ({
                label: stripTerminalControls(fact.label),
                value: stripTerminalControls(fact.value),
              })),
            };
    });
  }

  /** One line of subprocess output: a transient preview, kept briefly as possible evidence. */
  #renderFlowOutput(text: string): void {
    const content = stripTerminalControls(text);
    if (content.trim().length === 0) return;
    const flow = this.#flow;
    if (flow === undefined) {
      this.#renderFlowLine(content, "info");
      return;
    }
    flow.preview = content;
    flow.outputBuffer.push(content);
    if (flow.outputBuffer.length > FLOW_OUTPUT_BUFFER_CAP) flow.outputBuffer.shift();
    this.#host.paint();
  }

  /** The flow drawer, with `question` painted inside it. */
  rows(width: number, question: Surface | undefined): string[] {
    const flow = this.#flow;
    if (flow === undefined) return [];
    const indicator = { glyph: this.#host.pulse(flow.startedAtMs) };
    let status: FlowPanelStatus | undefined;
    if (flow.status !== undefined) {
      const elapsedMs = Date.now() - flow.status.startedAtMs;
      const elapsed = elapsedMs >= 5_000 ? ` ${formatTurnDuration(elapsedMs)}` : "";
      status = { text: `${flow.status.text}${elapsed}`, indicator };
    }
    let content: FlowPanelContent;
    if (question !== undefined) {
      const rows = question.rows!(width);
      content =
        status === undefined
          ? { kind: "question", title: flow.questionTitle, rows }
          : { kind: "question", title: flow.questionTitle, rows, status };
    } else if (status !== undefined) {
      content =
        flow.preview === undefined
          ? { kind: "status", status }
          : { kind: "status", status, preview: flow.preview };
    } else if (flow.preview !== undefined) {
      content = { kind: "preview", text: flow.preview, indicator };
    } else {
      content = { kind: "idle", indicator };
    }
    const lines: FlowPanelLine[] =
      flow.summary !== undefined
        ? [
            { text: flow.summary.headline, tone: "success" },
            ...flow.summary.facts.map((fact) => ({
              text: `${fact.label}: ${fact.value}`,
              tone: "info" as const,
            })),
          ]
        : flow.hideLinesWhileQuestion === true
          ? []
          : flow.lines;
    const drawer = renderFlowDrawer(
      { title: flow.title, navigation: flow.navigation, lines, content },
      this.#host.theme,
      width,
    );
    return [...drawer.rows, ...drawer.controls];
  }
}

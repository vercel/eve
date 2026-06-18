import type {
  EditableSelectOptions,
  EditableSelectResult,
  MultiSelectOptions,
  Prompter,
  PrompterValue,
  SearchSelectOptions,
  SearchSelectResult,
  SingleSelectOptions,
} from "#setup/prompter.js";
import { createSelectOptionCodec } from "#setup/cli/select-option-codec.js";
import { StepBackError, WizardCancelledError } from "#setup/step.js";

import { BACK } from "./setup-flow.js";
import type {
  Back,
  SetupFlowPrompterRenderer,
  SetupQuerySearchRequest,
  SetupSelectRequest,
} from "./setup-flow.js";

/**
 * The renderer slice the TUI-native prompter drives: the bordered setup
 * panel for questions, the footer status for ephemeral loading, and toned
 * transcript lines for persistent output. Same members as the optional
 * methods on {@link AgentTUIRenderer}, required here.
 */
export type TuiPrompterRenderer = SetupFlowPrompterRenderer;

function setupSelectRequest<T extends PrompterValue>(
  opts: SingleSelectOptions<T> | MultiSelectOptions<T>,
  options: SetupSelectRequest["options"],
  encode: (value: T) => string,
): SetupSelectRequest {
  const base: Pick<SetupSelectRequest, "message" | "messageTone" | "options"> = {
    message: opts.message,
    options,
  };
  if (opts.messageTone !== undefined) base.messageTone = opts.messageTone;
  const withNotices = <Request extends SetupSelectRequest>(request: Request): Request => {
    if (opts.notices !== undefined) request.notices = opts.notices;
    return request;
  };

  if (opts.multiple === true) {
    if (opts.hintLayout !== undefined) {
      throw new Error("Multi-select setup questions do not support a hint layout.");
    }

    let request: SetupSelectRequest;
    if (opts.search === true) {
      request = {
        ...base,
        kind: "searchable-multi",
        required: opts.required ?? false,
      };
      if (opts.placeholder !== undefined) request.placeholder = opts.placeholder;
    } else {
      request = {
        ...base,
        kind: "multi",
        required: opts.required ?? false,
      };
    }
    if (opts.initialValues !== undefined) {
      request.initialValues = opts.initialValues.map(encode);
    }
    return withNotices(request);
  }

  if (opts.search === true && opts.hintLayout !== undefined) {
    throw new Error("Searchable setup questions do not support a hint layout.");
  }

  let request: SetupSelectRequest;
  if (opts.search === true) {
    request = { ...base, kind: "search" };
    if (opts.placeholder !== undefined) request.placeholder = opts.placeholder;
  } else {
    // The public "inline" hint layout is the panel's "task-list" presentation.
    const kind = opts.hintLayout === "inline" ? "task-list" : (opts.hintLayout ?? "single");
    request = { ...base, kind };
  }
  if (opts.initialValue !== undefined) request.initialValue = encode(opts.initialValue);
  return withNotices(request);
}

/**
 * A {@link Prompter} implemented by the TUI itself: questions render as the
 * bordered setup panel (an input-region variant, clearly not chat content),
 * spinners become the footer's ephemeral status line, and log output lands
 * as toned transcript lines. A cancelled panel throws
 * {@link WizardCancelledError}, which the setup flows already fold.
 *
 * `intro`/`outro` are no-ops — the command's elbow-connected outcome line is
 * the opening and closing of a TUI flow.
 */
export function createTuiPrompter(renderer: TuiPrompterRenderer): Prompter {
  // Esc resolves a panel to BACK (step back one prompt); Ctrl-C / hard cancel
  // resolves to undefined. A reversible flow catches StepBackError to re-ask the
  // prior step; everywhere else it folds to a cancel via its WizardCancelledError
  // base, returning to chat.
  function guardCancel<T>(value: T | undefined | Back): T {
    if (value === BACK) throw new StepBackError();
    if (value === undefined) throw new WizardCancelledError();
    return value;
  }

  async function select<T extends PrompterValue>(opts: SingleSelectOptions<T>): Promise<T>;
  async function select<T extends PrompterValue>(opts: MultiSelectOptions<T>): Promise<T[]>;
  async function select<T extends PrompterValue>(
    opts: SingleSelectOptions<T> | MultiSelectOptions<T>,
  ): Promise<T | T[]> {
    const codec = createSelectOptionCodec(opts.options);
    const request = setupSelectRequest(opts, codec.options, codec.encode);

    const keys = guardCancel(await renderer.readSelect(request));
    const values = keys.map((key) => codec.decode(key));
    if (opts.multiple === true) return values;
    const value = values[0];
    if (value === undefined) {
      throw new Error("Single-select returned no option.");
    }
    return value;
  }

  async function searchSelect<T extends PrompterValue>(
    opts: SearchSelectOptions<T>,
  ): Promise<SearchSelectResult<T>> {
    const codec = createSelectOptionCodec(opts.options);
    const request: SetupQuerySearchRequest = {
      kind: "query-search",
      message: opts.message,
      options: codec.options,
      queryActionLabel: opts.queryActionLabel,
    };
    if (opts.initialValue !== undefined) {
      request.initialValue = codec.encode(opts.initialValue);
    }
    if (opts.initialQuery !== undefined) request.initialQuery = opts.initialQuery;
    if (opts.placeholder !== undefined) request.placeholder = opts.placeholder;
    if (opts.notices !== undefined) request.notices = opts.notices;

    const result = guardCancel(await renderer.readQuerySelect(request));
    return result.kind === "query"
      ? result
      : { kind: "selected", value: codec.decode(result.value) };
  }

  function line(tone: "info" | "success" | "warning" | "error") {
    return (text: string): void => renderer.renderLine(text, tone);
  }

  return {
    searchSelect,
    async text(opts) {
      const request: Parameters<TuiPrompterRenderer["readText"]>[0] = {
        message: opts.message,
      };
      if (opts.placeholder !== undefined) request.placeholder = opts.placeholder;
      if (opts.defaultValue !== undefined) request.defaultValue = opts.defaultValue;
      if (opts.validate !== undefined) request.validate = opts.validate;
      if (opts.notices !== undefined) request.notices = opts.notices;
      return guardCancel(await renderer.readText(request));
    },

    async password(opts) {
      const request: Parameters<TuiPrompterRenderer["readText"]>[0] = {
        message: opts.message,
        mask: true,
      };
      if (opts.validate !== undefined) request.validate = opts.validate;
      return guardCancel(await renderer.readText(request));
    },

    select,
    async selectEditable<T extends PrompterValue>(
      opts: EditableSelectOptions<T>,
    ): Promise<EditableSelectResult<T>> {
      const codec = createSelectOptionCodec(opts.options);
      const editable: Parameters<TuiPrompterRenderer["readEditableSelect"]>[0]["editable"] = {
        value: codec.encode(opts.editable.value),
        defaultValue: opts.editable.defaultValue,
        formatHint: opts.editable.formatHint,
      };
      if (opts.editable.validate !== undefined) editable.validate = opts.editable.validate;
      const request: Parameters<TuiPrompterRenderer["readEditableSelect"]>[0] = {
        message: opts.message,
        options: codec.options,
        editable,
      };
      if (opts.initialValue !== undefined) {
        request.initialValue = codec.encode(opts.initialValue);
      }
      const result = guardCancel(await renderer.readEditableSelect(request));
      const value = codec.decode(result.value);
      return result.kind === "edited"
        ? { kind: "edited", value, text: result.text }
        : { kind: "selected", value };
    },

    async acknowledge(opts) {
      await renderer.readAcknowledge({ message: opts.message, lines: opts.lines ?? [] });
    },

    awaitChoice(opts) {
      return renderer.readChoice(opts);
    },

    note(message, title, options) {
      const tone = options?.tone === "success" ? "success" : "warning";
      if (title) renderer.renderLine(title, tone);
      renderer.renderLine(message, tone);
    },

    intro() {},

    outro() {},

    log: {
      message: line("info"),
      info: line("info"),
      success: line("success"),
      warning: line("warning"),
      error: line("error"),
      // Subprocess output is a transient preview behind the spinner, not a
      // narrative line — the rail-log treats it the same way.
      commandOutput: (text) => renderer.renderOutput(text),
      section(title, lines) {
        renderer.renderLine(title, "info");
        for (const entry of lines) renderer.renderLine(`  ${entry}`, "info");
      },
      spinner(message) {
        renderer.setStatus(message);
        let stopped = false;
        return {
          stop() {
            if (stopped) return;
            stopped = true;
            renderer.setStatus(undefined);
          },
        };
      },
    },
  };
}

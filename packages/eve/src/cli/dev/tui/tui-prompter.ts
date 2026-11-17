import { PlannerNavigationError } from "#setup/prompter.js";
import type {
  EditableSelectOptions,
  EditableSelectResult,
  MultiSelectOptions,
  Prompter,
  PrompterValue,
  SelectOption,
  SingleSelectOptions,
} from "#setup/prompter.js";
import { createSelectOptionCodec } from "#setup/cli/select-option-codec.js";
import { searchActionQuery } from "#setup/cli/select-state.js";
import { WizardCancelledError } from "#setup/step.js";

import type { SetupFlowPrompterRenderer, SetupSelectRequest } from "./setup-flow.js";

export type TuiPrompterRenderer = SetupFlowPrompterRenderer;

function setupSelectRequest<T extends PrompterValue>(
  opts: SingleSelectOptions<T> | MultiSelectOptions<T>,
  options: SetupSelectRequest["options"],
  encode: (value: T) => string,
  encodeOptions: (options: readonly SelectOption<T>[]) => SetupSelectRequest["options"],
): SetupSelectRequest {
  const base: {
    message: string;
    options: SetupSelectRequest["options"];
    description?: string;
    helpText?: string;
    metadata?: SetupSelectRequest["metadata"];
  } = { message: opts.message, options };
  if (opts.description !== undefined) base.description = opts.description;
  if (opts.helpText !== undefined) base.helpText = opts.helpText;
  if (opts.metadata !== undefined) base.metadata = opts.metadata;
  const withContext = <Request extends SetupSelectRequest>(request: Request): Request => {
    if (opts.notices !== undefined) request.notices = opts.notices;
    if (opts.navigation !== undefined) request.navigation = opts.navigation;
    return request;
  };

  if (opts.multiple === true) {
    let request: SetupSelectRequest;
    if (opts.search === true) {
      request = {
        ...base,
        kind: "searchable-multi",
        required: opts.required ?? false,
      };
      if (opts.hintLayout === "stacked") request.layout = "stacked";
      if (opts.hintLayout === "inline") {
        throw new Error("Multi-select setup questions do not support inline hint layout.");
      }
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
    return withContext(request);
  }

  if (opts.search === true && opts.hintLayout === "stacked") {
    throw new Error("Searchable setup questions do not support a stacked hint layout.");
  }

  let request: SetupSelectRequest;
  if (opts.search === true) {
    request = { ...base, kind: "search" };
    if (opts.hintLayout === "inline") request.layout = "task-list";
    if (opts.placeholder !== undefined) request.placeholder = opts.placeholder;
    if (opts.searchAction !== undefined) {
      request.searchAction = { label: opts.searchAction.label };
      const load = opts.searchAction.load;
      if (load !== undefined) {
        request.searchAction.load = async (query) => encodeOptions(await load(query));
      }
    }
  } else {
    const kind = opts.hintLayout === "inline" ? "task-list" : (opts.hintLayout ?? "single");
    request = { ...base, kind };
  }
  if (opts.initialValue !== undefined) request.initialValue = encode(opts.initialValue);
  return withContext(request);
}

export function createTuiPrompter(renderer: TuiPrompterRenderer): Prompter {
  function guardCancel<T>(value: T | undefined): T {
    if (value === undefined) throw new WizardCancelledError();
    return value;
  }

  async function select<T extends PrompterValue>(opts: SingleSelectOptions<T>): Promise<T>;
  async function select<T extends PrompterValue>(opts: MultiSelectOptions<T>): Promise<T[]>;
  async function select<T extends PrompterValue>(
    opts: SingleSelectOptions<T> | MultiSelectOptions<T>,
  ): Promise<T | T[]> {
    const codec = createSelectOptionCodec(opts.options);
    const request = setupSelectRequest(opts, codec.options, codec.encode, codec.encodeOptions);

    const result = guardCancel(await renderer.readSelect(request));
    if ("kind" in result) {
      throw new PlannerNavigationError(result.direction, result.values.map(codec.decode));
    }
    const values = result.map((key) => {
      const query = searchActionQuery(key);
      if (query !== undefined && opts.multiple !== true && opts.searchAction !== undefined) {
        return opts.searchAction.value(query);
      }
      return codec.decode(key);
    });
    if (opts.multiple === true) return values;
    const value = values[0];
    if (value === undefined) {
      throw new Error("Single-select returned no option.");
    }
    return value;
  }

  function line(tone: "info" | "success" | "warning" | "error") {
    return (text: string): void => renderer.renderLine(text, tone);
  }

  return {
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

    replaceContent: (content) => renderer.replaceContent?.(content),

    withInheritedStdio: (task) => renderer.withInheritedStdio(task),

    withExclusiveTerminal: (task) => renderer.withExclusiveTerminal?.(task) ?? task(),

    log: {
      message: line("info"),
      info: line("info"),
      success: line("success"),
      warning: line("warning"),
      error: line("error"),
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

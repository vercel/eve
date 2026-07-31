import type {
  EditableSelectOptions,
  MultiSelectOptions,
  Prompter,
  PrompterValue,
  SelectNotice,
  SingleSelectOptions,
} from "./prompter.js";
import { WizardCancelledError } from "./step.js";
import {
  REGISTRY_SETUP_PROTOCOL_VERSION,
  type RegistrySetupChildMessage,
  type RegistrySetupFact,
  type RegistrySetupOutcome,
  type RegistrySetupParentMessage,
  type RegistrySetupPrompt,
} from "./registry-setup-protocol.js";

interface SetupProcess extends NodeJS.Process {
  send?: (message: RegistrySetupChildMessage) => boolean;
}

function send(process: SetupProcess, message: RegistrySetupChildMessage): void {
  if (process.send === undefined || !process.connected) {
    throw new Error("The registry setup host disconnected.");
  }
  process.send(message);
}

function registrySetupError(error: unknown): { message: string; details?: readonly string[] } {
  if (!(error instanceof Error)) return { message: String(error) };
  const details = error.stack
    ?.split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean);
  return details === undefined || details.length === 0
    ? { message: error.message }
    : { message: error.message, details };
}

export interface RegistrySetupClient {
  prompter: Prompter;
  signal: AbortSignal;
  complete(facts?: readonly RegistrySetupFact[]): void;
  cancel(): void;
  fail(error: unknown): void;
}

/** Creates a prompter whose questions and output are rendered by the parent eve process. */
export function createRegistrySetupClient(
  input: {
    process?: SetupProcess;
    signal?: AbortSignal;
  } = {},
): RegistrySetupClient | undefined {
  const childProcess = input.process ?? process;
  if (childProcess.send === undefined || process.env.EVE_SETUP_PROTOCOL === undefined)
    return undefined;

  const controller = new AbortController();
  if (input.signal !== undefined) {
    input.signal.addEventListener("abort", () => controller.abort(input.signal?.reason), {
      once: true,
    });
  }
  let nextId = 1;
  const pending = new Map<number, (message: RegistrySetupParentMessage) => void>();
  const onMessage = (message: RegistrySetupParentMessage): void => {
    if (message.type === "cancel") {
      controller.abort(new WizardCancelledError());
      for (const settle of pending.values()) settle({ type: "cancel" });
      pending.clear();
      return;
    }
    pending.get(message.id)?.(message);
  };
  childProcess.on("message", onMessage);
  send(childProcess, { type: "ready", version: REGISTRY_SETUP_PROTOCOL_VERSION });

  async function prompt<T>(request: RegistrySetupPrompt): Promise<T> {
    controller.signal.throwIfAborted();
    const id = nextId++;
    const result = await new Promise<RegistrySetupParentMessage>((resolve) => {
      pending.set(id, resolve);
      send(childProcess, { type: "prompt", id, prompt: request });
    });
    pending.delete(id);
    if (result.type === "cancel" || result.cancelled === true) {
      throw new WizardCancelledError();
    }
    return result.value as T;
  }

  async function validatedText(
    kind: "text" | "password",
    options: {
      message: string;
      placeholder?: string;
      defaultValue?: string;
      validate?: (value: string) => string | undefined;
      notices?: readonly SelectNotice[];
    },
  ): Promise<string> {
    let notices = options.notices;
    while (true) {
      const value = await prompt<string>({
        kind,
        message: options.message,
        placeholder: options.placeholder,
        defaultValue: options.defaultValue,
        notices,
      });
      const error = options.validate?.(value);
      if (error === undefined) return value;
      notices = [{ tone: "error", text: error }];
    }
  }

  function select<T extends PrompterValue>(options: SingleSelectOptions<T>): Promise<T>;
  function select<T extends PrompterValue>(options: MultiSelectOptions<T>): Promise<T[]>;
  function select<T extends PrompterValue>(
    options: SingleSelectOptions<T> | MultiSelectOptions<T>,
  ): Promise<T | T[]> {
    return prompt<T | T[]>({ kind: "select", options });
  }

  const prompter: Prompter = {
    text: (options) => validatedText("text", options),
    password: (options) => validatedText("password", options),
    select,
    async selectEditable<T extends PrompterValue>(options: EditableSelectOptions<T>) {
      const result = await prompt<
        { kind: "selected"; value: T } | { kind: "edited"; value: T; text: string }
      >({
        kind: "editable-select",
        options: {
          ...options,
          editable: {
            value: options.editable.value,
            defaultValue: options.editable.defaultValue,
          },
        },
      });
      if (result.kind === "selected") return { kind: "selected", value: result.value };
      const error = options.editable.validate?.(result.text);
      if (error !== undefined) throw new Error(error);
      return { kind: "edited", value: result.value, text: result.text };
    },
    acknowledge: (options) => prompt<void>({ kind: "acknowledge", options }),
    awaitChoice(options) {
      const id = nextId++;
      const choice = new Promise<string | undefined>((resolve, reject) => {
        pending.set(id, (message) => {
          pending.delete(id);
          if (message.type === "cancel" || message.cancelled === true) {
            reject(new WizardCancelledError());
          } else {
            resolve(message.value as string | undefined);
          }
        });
        send(childProcess, { type: "prompt", id, prompt: { kind: "choice", options } });
      });
      return {
        choice,
        close: () => {
          pending.delete(id);
          send(childProcess, { type: "close-prompt", id });
        },
      };
    },
    note(message, title, options) {
      send(childProcess, { type: "note", message, title, tone: options?.tone });
    },
    intro(text, subtitle) {
      send(childProcess, { type: "intro", text, subtitle });
    },
    outro(text) {
      send(childProcess, { type: "outro", text });
    },
    log: {
      message: (text) => send(childProcess, { type: "log", level: "message", text }),
      info: (text) => send(childProcess, { type: "log", level: "info", text }),
      success: (text) => send(childProcess, { type: "log", level: "success", text }),
      warning: (text) => send(childProcess, { type: "log", level: "warning", text }),
      error: (text) => send(childProcess, { type: "log", level: "error", text }),
      commandOutput: (text) => send(childProcess, { type: "log", level: "commandOutput", text }),
      spinner(status, intent) {
        const id = nextId++;
        send(childProcess, {
          type: "status",
          id,
          status,
          intent: intent?.kind === "external-action" ? intent : undefined,
        });
        return { stop: () => send(childProcess, { type: "status", id }) };
      },
    },
  };
  let terminal = false;
  const finish = (outcome: RegistrySetupOutcome): void => {
    if (terminal) return;
    terminal = true;
    send(childProcess, { type: "result", outcome });
  };
  return {
    prompter,
    signal: controller.signal,
    complete: (facts = []) => finish({ kind: "completed", facts }),
    cancel: () => finish({ kind: "cancelled" }),
    fail: (error) => finish({ kind: "failed", error: registrySetupError(error) }),
  };
}

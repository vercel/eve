import type {
  MultiSelectOptions,
  Prompter,
  PrompterValue,
  SingleSelectOptions,
} from "./prompter.js";

export class HeadlessPromptError extends Error {
  readonly promptMessage: string;

  constructor(promptMessage: string) {
    super(
      `Headless run needs every decision up front, but the flow tried to ask: "${promptMessage}". ` +
        "Provide the matching flag (--model, --channels, --skip-vercel, --project, --team, " +
        "--gateway-api-key, --chat) and re-run.",
    );
    this.name = "HeadlessPromptError";
    this.promptMessage = promptMessage;
  }
}

export type HeadlessLogSink = (text: string) => void;

export function createHeadlessPrompter(sink: HeadlessLogSink): Prompter {
  const fail = (message: string): never => {
    throw new HeadlessPromptError(message);
  };
  function select<T extends PrompterValue>(opts: SingleSelectOptions<T>): Promise<T>;
  function select<T extends PrompterValue>(opts: MultiSelectOptions<T>): Promise<T[]>;
  async function select<T extends PrompterValue>(
    opts: SingleSelectOptions<T> | MultiSelectOptions<T>,
  ): Promise<T | T[]> {
    return fail(opts.message);
  }

  return {
    text: async (opts) => fail(opts.message),
    password: async (opts) => fail(opts.message),
    select,
    note: (message) => sink(message),
    intro: (title, subtitle) => sink(subtitle ? `${title}: ${subtitle}` : title),
    outro: (message) => sink(message),
    log: {
      message: (text) => sink(text),
      info: (text) => sink(text),
      success: (text) => sink(text),
      warning: (text) => sink(text),
      error: (text) => sink(text),
      commandOutput: (text) => sink(text),
    },
  };
}

export interface HeadlessNextStep {
  command: string;
}

export type HeadlessEvent =
  | { type: "done"; projectPath: string; channels: string[]; model: string }
  | {
      type: "action-required";
      status: "action_required";
      kind: string;
      reason: string;
      message: string;
      command: string;
      next: HeadlessNextStep[];
    }
  | { type: "error"; status: "error"; reason: string; message: string; hint?: string };

export function formatHeadlessEvent(event: HeadlessEvent): string {
  return JSON.stringify(event);
}

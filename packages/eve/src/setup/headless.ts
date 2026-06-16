import type {
  MultiSelectOptions,
  Prompter,
  PrompterValue,
  SingleSelectOptions,
} from "./prompter.js";

/**
 * Thrown when the headless create flow reaches a decision that no flag
 * answered. Surfaced to the caller as a structured error event so an AI
 * agent driving `--json` learns exactly which flag is missing.
 */
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

/** Sink for human-readable progress lines emitted during a headless run. */
export type HeadlessLogSink = (text: string) => void;

/**
 * A {@link Prompter} that never blocks on input. Every interactive method
 * rejects with {@link HeadlessPromptError}; log output is forwarded to `sink`.
 * Used by non-interactive setup callers so an AI agent can
 * drive the create flow non-interactively: when a flag is missing the run
 * fails fast with a precise message instead of hanging on a TTY prompt.
 */
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

/** A structured lifecycle event emitted as one NDJSON line on stdout in `--json` mode. */
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

/** Serializes one event as a single NDJSON line. */
export function formatHeadlessEvent(event: HeadlessEvent): string {
  return JSON.stringify(event);
}

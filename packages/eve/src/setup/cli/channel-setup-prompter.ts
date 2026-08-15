import type { ChannelKind } from "../scaffold/update/channels.js";

/** Reasons that make scaffoldable channel kinds unavailable in a picker. */
export type DisabledChannelReasons = Readonly<Partial<Record<ChannelKind, string>>>;

/** One selectable action shown while a setup operation continues in the background. */
export interface ChannelSetupAction {
  value: string;
  label: string;
}

/** Context plus actions shown while a setup operation continues in the background. */
export interface ChannelSetupChoiceOptions {
  /** The animated spinner line shown above the actions. */
  status: string;
  /** Inert row explaining what the background operation is waiting for. */
  context: string;
  /** Selectable actions, visually separated from the context row. */
  actions: readonly ChannelSetupAction[];
}

/** Concurrent setup choice plus an idempotent prompt dismissal handle. */
export interface ChannelSetupChoice {
  choice: Promise<string | undefined>;
  close(): void;
}

/** Optional interaction capability for a long-running setup operation. */
export type ChannelSetupAwaitChoice = (options: ChannelSetupChoiceOptions) => ChannelSetupChoice;

/** Why a live setup indicator is waiting. */
export type SetupSpinnerIntent =
  | { kind: "progress" }
  | { kind: "external-action"; emphasis: string };

/** Status and subprocess output operations used by shared setup flows. */
export interface ChannelSetupLog {
  message(text: string): void;
  info(text: string): void;
  success(text: string): void;
  warning(text: string): void;
  error(text: string): void;
  /** Updates the transient detail beneath the current status while a child command runs. */
  commandOutput(text: string): void;
  /**
   * Starts an ephemeral progress indicator for an async wait, returning a
   * handle whose `stop()` clears it without leaving a transcript line.
   * Mirrors `Prompter["log"]["spinner"]`; optional so plain and headless logs
   * (which have no live status surface) can omit it and callers fall back to
   * a persisted message.
   */
  spinner?(message: string, intent?: SetupSpinnerIntent): { stop(): void };
}

/**
 * Runs one setup phase behind an ephemeral spinner so only outcomes persist in
 * the transcript. Logs without a spinner (plain or headless output) persist the
 * phase message instead, keeping their progress trail; the spinner stops
 * whether the work resolves or throws.
 */
export async function withPhase<T>(
  log: ChannelSetupLog,
  message: string,
  task: () => Promise<T>,
  intent?: SetupSpinnerIntent,
): Promise<T> {
  const spinner = log.spinner?.(message, intent);
  if (!spinner) log.message(message);
  try {
    return await task();
  } finally {
    spinner?.stop();
  }
}

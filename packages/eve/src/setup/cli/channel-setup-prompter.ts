import type { ChannelKind } from "../scaffold/update/channels.js";

export type DisabledChannelReasons = Readonly<Partial<Record<ChannelKind, string>>>;

export interface ChannelSetupAction {
  value: string;
  label: string;
}

export interface ChannelSetupChoiceOptions {
  status: string;
  context: string;
  actions: readonly ChannelSetupAction[];
}

export interface ChannelSetupChoice {
  choice: Promise<string | undefined>;
  close(): void;
}

export type ChannelSetupAwaitChoice = (options: ChannelSetupChoiceOptions) => ChannelSetupChoice;

export interface ChannelSetupLog {
  message(text: string): void;
  info(text: string): void;
  success(text: string): void;
  warning(text: string): void;
  error(text: string): void;
  commandOutput(text: string): void;
  spinner?(message: string): { stop(): void };
}

export async function withPhase<T>(
  log: ChannelSetupLog,
  message: string,
  task: () => Promise<T>,
): Promise<T> {
  const spinner = log.spinner?.(message);
  if (!spinner) log.message(message);
  try {
    return await task();
  } finally {
    spinner?.stop();
  }
}

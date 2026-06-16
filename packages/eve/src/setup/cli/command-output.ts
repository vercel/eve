import type { ProcessOutputHandler } from "../primitives/process-output.js";

/** Minimum prompt log operation needed to show command output inside a setup flow. */
export interface PromptCommandLog {
  commandOutput(text: string): void;
}

/**
 * Routes child stdout and stderr through the prompt's transient command detail.
 *
 * Stderr is not styled as an error because several CLIs write ordinary progress
 * output there. The surrounding step owns success and failure state.
 */
export function createPromptCommandOutput(log: PromptCommandLog): ProcessOutputHandler {
  return ({ text }) => log.commandOutput(text);
}

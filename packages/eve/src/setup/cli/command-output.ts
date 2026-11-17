import type { ProcessOutputHandler } from "../primitives/process-output.js";

export interface PromptCommandLog {
  commandOutput(text: string): void;
}

export function createPromptCommandOutput(log: PromptCommandLog): ProcessOutputHandler {
  return ({ text }) => log.commandOutput(text);
}

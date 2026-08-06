import { confirm, SkippedSignal, type Asker } from "../../ask.js";
import type { Prompter } from "../../prompter.js";

/** UI capabilities available to a channel-owned setup hook. */
export interface IntegrationSetupUi {
  readonly asker: Asker;
  readonly prompter: Prompter;
  confirm(input: { key: string; message: string; recommended?: boolean }): Promise<boolean>;
  nextSteps(lines: readonly string[]): void;
}

/** Adapts the shared setup asker and prompter to the channel hook UI. */
export function createIntegrationSetupUi(input: {
  asker: Asker;
  prompter: Prompter;
}): IntegrationSetupUi {
  return {
    ...input,
    async confirm(question) {
      try {
        return await input.asker.ask(confirm(question));
      } catch (error) {
        if (error instanceof SkippedSignal) return false;
        throw error;
      }
    },
    nextSteps(lines) {
      if (lines.length === 0) return;
      input.prompter.note(lines.join("\n"), "Next steps", { tone: "success" });
    },
  };
}

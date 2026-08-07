import type { Asker } from "../../ask.js";
import type { Prompter } from "../../prompter.js";
import type { SetupApplyContext, SetupPrepareContext, SetupPresentation } from "../types.js";

export function createSetupPresentation(
  prompter: Prompter,
  onExternalAction?: (input: { url: string; userCode?: string; message: string }) => void,
): SetupPresentation {
  return {
    log: prompter.log,
    note: prompter.note.bind(prompter),
    nextSteps(lines) {
      if (lines.length > 0) prompter.note(lines.join("\n"), "Next steps", { tone: "success" });
    },
    externalAction(input) {
      if (onExternalAction !== undefined) {
        onExternalAction(input);
        return;
      }
      prompter.log.message(input.message);
      prompter.log.message(input.url);
      if (input.userCode !== undefined) prompter.log.message(`Code: ${input.userCode}`);
    },
  };
}

export function createSetupContexts(input: {
  appRoot: string;
  asker: Asker;
  environment: SetupPrepareContext["environment"];
  prompter: Prompter;
  signal?: AbortSignal;
  force?: boolean;
  onExternalAction?: (input: { url: string; userCode?: string; message: string }) => void;
}): { prepare: SetupPrepareContext; apply: SetupApplyContext } {
  const presentation = createSetupPresentation(input.prompter, input.onExternalAction);
  const apply: SetupApplyContext = { appRoot: input.appRoot, presentation };
  if (input.signal !== undefined) apply.signal = input.signal;
  if (input.force !== undefined) apply.force = input.force;
  return {
    prepare: { ...apply, asker: input.asker, environment: input.environment },
    apply,
  };
}

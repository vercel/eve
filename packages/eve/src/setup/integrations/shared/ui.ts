import type { Asker } from "../../ask.js";
import type { Prompter } from "../../prompter.js";
import type { SetupApplyContext, SetupPrepareContext, SetupPresenter } from "../types.js";

export function createSetupPresenter(
  prompter: Prompter,
  onExternalAction?: (input: { url: string; userCode?: string; message: string }) => void,
): SetupPresenter {
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
  const presenter = createSetupPresenter(input.prompter, input.onExternalAction);
  const apply: SetupApplyContext = { appRoot: input.appRoot, presenter };
  if (input.signal !== undefined) apply.signal = input.signal;
  if (input.force !== undefined) apply.force = input.force;
  return {
    prepare: { ...apply, asker: input.asker, environment: input.environment },
    apply,
  };
}

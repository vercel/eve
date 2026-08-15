import type { Asker } from "../../ask.js";
import type { Prompter } from "../../prompter.js";
import type {
  SetupApplyContext,
  SetupExternalAction,
  SetupPrepareContext,
  SetupPresenter,
} from "../types.js";

export function createSetupPresenter(
  prompter: Prompter,
  beginExternalAction?: (input: {
    url: string;
    userCode?: string;
    message: string;
  }) => SetupExternalAction,
): SetupPresenter {
  return {
    log: prompter.log,
    note: prompter.note.bind(prompter),
    nextSteps(lines) {
      if (lines.length > 0) prompter.note(lines.join("\n"), "Next steps", { tone: "success" });
    },
    beginExternalAction(input) {
      if (beginExternalAction !== undefined) return beginExternalAction(input);
      prompter.log.message(input.message);
      prompter.log.message(input.url);
      if (input.userCode !== undefined) prompter.log.message(`Code: ${input.userCode}`);
      return { complete() {} };
    },
  };
}

export function createSetupContexts(input: {
  appRoot: string;
  asker: Asker;
  environment: SetupPrepareContext["environment"];
  prompter: Prompter;
  resolveVercelProject: SetupPrepareContext["resolveVercelProject"];
  signal?: AbortSignal;
  force?: boolean;
  beginExternalAction?: (input: {
    url: string;
    userCode?: string;
    message: string;
  }) => SetupExternalAction;
}): { prepare: SetupPrepareContext; apply: SetupApplyContext } {
  const presenter = createSetupPresenter(input.prompter, input.beginExternalAction);
  const apply: SetupApplyContext = { appRoot: input.appRoot, presenter };
  if (input.signal !== undefined) apply.signal = input.signal;
  if (input.force !== undefined) apply.force = input.force;
  return {
    prepare: {
      ...apply,
      asker: input.asker,
      environment: input.environment,
      resolveVercelProject: input.resolveVercelProject,
    },
    apply,
  };
}

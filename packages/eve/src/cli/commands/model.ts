import { isEveProject } from "#setup/scaffold/index.js";
import { modelChangeRefusalForUneditableModel } from "#setup/flows/model.js";
import {
  changeAgentModel,
  formatApplyModelOutcome,
  type ApplyModelOutcome,
} from "#setup/flows/model-source-change.js";

import { NOT_AN_AGENT_MESSAGE } from "./preconditions.js";

export interface ModelCommandLogger {
  error(message: string): void;
  log(message: string): void;
}

export interface ModelCommandDependencies {
  changeAgentModel: (input: { appRoot: string; slug: string }) => Promise<ApplyModelOutcome>;
  isEveProject: typeof isEveProject;
  modelChangeRefusal: (appRoot: string) => Promise<string | null>;
}

const defaultDependencies: ModelCommandDependencies = {
  changeAgentModel,
  isEveProject,
  modelChangeRefusal: modelChangeRefusalForUneditableModel,
};

function fail(logger: ModelCommandLogger, message: string): void {
  logger.error(message);
  process.exitCode = 1;
}

/** Changes the root agent model for `eve model <model>`. */
export async function runModelCommand(
  logger: ModelCommandLogger,
  appRoot: string,
  slug: string,
  dependencies: ModelCommandDependencies = defaultDependencies,
): Promise<void> {
  if (!(await dependencies.isEveProject(appRoot))) {
    fail(logger, NOT_AN_AGENT_MESSAGE);
    return;
  }

  try {
    const refusal = await dependencies.modelChangeRefusal(appRoot);
    if (refusal !== null) {
      fail(logger, refusal);
      return;
    }

    const outcome = await dependencies.changeAgentModel({ appRoot, slug });
    if (outcome.kind === "rejected") {
      fail(logger, outcome.message);
      return;
    }
    logger.log(formatApplyModelOutcome(outcome));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(logger, `Couldn't change the model: ${message}`);
  }
}

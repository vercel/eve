import { isEveProject } from "#setup/scaffold/index.js";
import {
  changeAgentModelSettings,
  formatApplyModelSettingsOutcome,
  type ApplyModelSettingsOutcome,
} from "#setup/flows/model-source-change.js";
import type { AgentReasoningDefinition } from "#shared/agent-definition.js";
import type { AgentModelSettingsPatch } from "#source-change/apply-agent-model-settings.js";

import { NOT_AN_AGENT_MESSAGE } from "./preconditions.js";

export interface SetCommandLogger {
  error(message: string): void;
  log(message: string): void;
}

export interface SetCommandOptions {
  model?: string;
  reasoning?: AgentReasoningDefinition;
}

export interface SetCommandDependencies {
  changeAgentModelSettings: (input: {
    appRoot: string;
    patch: AgentModelSettingsPatch;
  }) => Promise<ApplyModelSettingsOutcome>;
  isEveProject: typeof isEveProject;
}

const defaultDependencies: SetCommandDependencies = {
  changeAgentModelSettings,
  isEveProject,
};

function fail(logger: SetCommandLogger, message: string): void {
  logger.error(message);
  process.exitCode = 1;
}

export async function runSetCommand(
  logger: SetCommandLogger,
  appRoot: string,
  options: SetCommandOptions,
  dependencies: SetCommandDependencies = defaultDependencies,
): Promise<void> {
  if (options.model === undefined && options.reasoning === undefined) {
    fail(logger, "Pass --model, --reasoning, or both.");
    return;
  }

  if (!(await dependencies.isEveProject(appRoot))) {
    fail(logger, NOT_AN_AGENT_MESSAGE);
    return;
  }

  const patch: AgentModelSettingsPatch = {
    model: options.model === undefined ? { kind: "keep" } : { kind: "set", value: options.model },
    reasoning:
      options.reasoning === undefined
        ? { kind: "keep" }
        : options.reasoning === "provider-default"
          ? { kind: "remove" }
          : { kind: "set", value: options.reasoning },
    gatewayServiceTier: { kind: "keep" },
  };

  try {
    const outcome = await dependencies.changeAgentModelSettings({ appRoot, patch });
    if (outcome.kind === "rejected") {
      fail(logger, outcome.message);
      return;
    }
    logger.log(formatApplyModelSettingsOutcome(outcome));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(logger, `Couldn't update model settings: ${message}`);
  }
}

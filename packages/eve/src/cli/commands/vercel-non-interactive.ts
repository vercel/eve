import { runVercelEnvPull } from "#setup/run-vercel-link.js";
import { isEveProject } from "#setup/scaffold/index.js";
import { runVercel } from "#setup/primitives/index.js";

import { NOT_AN_AGENT_MESSAGE } from "./preconditions.js";

export interface VercelNonInteractiveLogger {
  error(message: string): void;
  log(message: string): void;
}

export interface VercelProjectCliOptions {
  nonInteractive?: boolean;
  project?: string;
  team?: string;
}

export interface NonInteractiveLinkDependencies {
  isEveProject: typeof isEveProject;
  runVercel: typeof runVercel;
  runVercelEnvPull: typeof runVercelEnvPull;
}

const defaultDependencies: NonInteractiveLinkDependencies = {
  isEveProject,
  runVercel,
  runVercelEnvPull,
};

export function isNonInteractiveProjectCommand(options: VercelProjectCliOptions): boolean {
  return options.nonInteractive === true;
}

/** Links a named Vercel project and refreshes its local environment without a prompt. */
export async function runNonInteractiveLink(input: {
  logger: VercelNonInteractiveLogger;
  appRoot: string;
  options: VercelProjectCliOptions;
  dependencies?: NonInteractiveLinkDependencies;
}): Promise<boolean> {
  const { appRoot, logger, options } = input;
  const dependencies = input.dependencies ?? defaultDependencies;
  if (!(await dependencies.isEveProject(appRoot))) {
    logger.error(NOT_AN_AGENT_MESSAGE);
    process.exitCode = 1;
    return false;
  }
  if (options.project === undefined) {
    logger.error("`eve link --non-interactive` requires `--project <name-or-id>`.");
    process.exitCode = 1;
    return false;
  }

  const args = [
    "link",
    "--project",
    options.project,
    ...(options.team === undefined ? [] : ["--team", options.team]),
    "--yes",
  ];
  if (!(await dependencies.runVercel(args, { cwd: appRoot, nonInteractive: true }))) {
    process.exitCode = 1;
    return false;
  }
  if (!(await dependencies.runVercelEnvPull(appRoot, undefined, undefined, true))) {
    logger.error("Vercel project linked, but pulling environment variables did not complete.");
    process.exitCode = 1;
    return false;
  }
  logger.log("Project linked.");
  return true;
}

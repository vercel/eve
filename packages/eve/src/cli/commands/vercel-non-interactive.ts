import { runVercelEnvPull } from "#setup/run-vercel-link.js";
import { isEveProject } from "#setup/scaffold/index.js";
import { runVercel } from "#setup/primitives/index.js";
import { readProjectLink, type VercelProjectReference } from "#setup/project-resolution.js";
import { resolveProjectByNameOrId, resolveTeam } from "#setup/vercel-project.js";

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
  readProjectLink: typeof readProjectLink;
  resolveTeam: typeof resolveTeam;
  resolveProjectByNameOrId: typeof resolveProjectByNameOrId;
}

const defaultDependencies: NonInteractiveLinkDependencies = {
  isEveProject,
  runVercel,
  runVercelEnvPull,
  readProjectLink,
  resolveTeam,
  resolveProjectByNameOrId,
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
  onCreatedProject?: (link: VercelProjectReference) => Promise<void>;
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

  const existing =
    input.onCreatedProject === undefined
      ? undefined
      : await dependencies.resolveProjectByNameOrId(
          appRoot,
          await dependencies.resolveTeam(appRoot, options.team),
          options.project,
        );
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
  if (existing === null && input.onCreatedProject !== undefined) {
    const link = await dependencies.readProjectLink(appRoot);
    if (link === undefined) {
      throw new Error("Vercel project linked, but its project identity could not be read.");
    }
    await input.onCreatedProject(link);
  }
  if (!(await dependencies.runVercelEnvPull(appRoot, undefined, undefined, true))) {
    logger.error("Vercel project linked, but pulling environment variables did not complete.");
    process.exitCode = 1;
    return false;
  }
  logger.log("Project linked.");
  return true;
}

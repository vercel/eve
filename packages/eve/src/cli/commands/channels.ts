import { isEveProject, listAuthoredChannels } from "#setup/scaffold/index.js";

import { NOT_AN_AGENT_MESSAGE } from "./preconditions.js";

export interface CliLogger {
  error(message: string): void;
  log(message: string): void;
}

export interface ListChannelsCommandOptions {
  json?: boolean;
}

export async function runChannelsListCommand(
  logger: CliLogger,
  appRoot: string,
  options: ListChannelsCommandOptions,
): Promise<void> {
  if (!(await isEveProject(appRoot))) {
    logger.error(NOT_AN_AGENT_MESSAGE);
    process.exitCode = 1;
    return;
  }

  const channels = await listAuthoredChannels(appRoot);

  if (options.json) {
    logger.log(JSON.stringify({ channels }, null, 2));
    return;
  }

  if (channels.length === 0) {
    logger.log("No channels defined. Run `eve add <channel>` to add one.");
    return;
  }

  for (const name of channels) logger.log(name);
}

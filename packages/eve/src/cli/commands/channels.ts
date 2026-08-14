import type { ResolvedDiscoveryProject } from "#discover/project.js";
import { listAuthoredChannels } from "#setup/scaffold/index.js";

export interface CliLogger {
  error(message: string): void;
  log(message: string): void;
}

export interface ListChannelsCommandOptions {
  json?: boolean;
}

export async function runChannelsListCommand(
  logger: CliLogger,
  project: ResolvedDiscoveryProject,
  options: ListChannelsCommandOptions,
): Promise<void> {
  const channels = await listAuthoredChannels(project.agentRoot);

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

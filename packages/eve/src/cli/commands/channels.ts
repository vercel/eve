import { isEveProject, listAuthoredChannels, type ChannelKind } from "#setup/scaffold/index.js";
import { createPrompter, type Prompter } from "#setup/prompter.js";
import type { runChannelsFlow } from "#setup/flows/channels.js";

import { NOT_AN_AGENT_MESSAGE } from "./preconditions.js";
import type { AddCommandOptions, runAddCommand } from "./registry.js";

export interface CliLogger {
  error(message: string): void;
  log(message: string): void;
}

const KNOWN_CHANNEL_KINDS: readonly ChannelKind[] = ["slack", "web"];

function parseChannelKind(value: string): ChannelKind {
  if (KNOWN_CHANNEL_KINDS.includes(value as ChannelKind)) return value as ChannelKind;
  throw new Error(`Unknown channel kind "${value}". Known: ${KNOWN_CHANNEL_KINDS.join(", ")}.`);
}

export interface AddChannelCommandOptions {
  force?: boolean;
  yes?: boolean;
}

export interface ChannelsAddDependencies {
  createPrompter(): Prompter;
  loadAddCommand(): Promise<typeof runAddCommand>;
  loadChannelsFlow(): Promise<typeof runChannelsFlow>;
}

const defaultChannelsAddDependencies: ChannelsAddDependencies = {
  createPrompter,
  loadAddCommand: async () => (await import("./registry.js")).runAddCommand,
  loadChannelsFlow: async () => (await import("#setup/flows/channels.js")).runChannelsFlow,
};

/** Compatibility adapter from `eve channels add` to registry-backed installation. */
export async function runChannelsAddCompatibilityCommand(
  logger: CliLogger,
  appRoot: string,
  args: { kind?: string; options: AddChannelCommandOptions },
  dependencies: ChannelsAddDependencies = defaultChannelsAddDependencies,
): Promise<void> {
  if (!(await isEveProject(appRoot))) {
    logger.error(NOT_AN_AGENT_MESSAGE);
    process.exitCode = 1;
    return;
  }

  try {
    if (args.kind !== undefined) {
      const kind = parseChannelKind(args.kind);
      const runAdd = await dependencies.loadAddCommand();
      const addOptions: AddCommandOptions = {};
      if (args.options.force === true) addOptions.overwrite = true;
      if (args.options.yes === true) addOptions.yes = true;
      await runAdd(logger, appRoot, `channel/${kind}`, addOptions);
      return;
    }
    if (args.options.yes || !process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error(
        `Pass a channel kind: \`eve channels add <${KNOWN_CHANNEL_KINDS.join("|")}>\`.`,
      );
    }
    const runFlow = await dependencies.loadChannelsFlow();
    await runFlow({ appRoot, prompter: dependencies.createPrompter() });
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
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
    logger.log("No channels defined. Run `eve channels add` to add one.");
    return;
  }

  for (const name of channels) logger.log(name);
}

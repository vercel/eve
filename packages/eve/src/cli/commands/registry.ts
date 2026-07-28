import {
  addRegistryItems,
  getRegistryItems,
  searchRegistries,
  type RegistryConfig,
} from "#compiled/shadcn-registry/index.js";
import { z } from "#compiled/zod/index.js";
import { isEveProject, type ChannelKind } from "#setup/scaffold/index.js";

import type { runChannelsAddCommand } from "./channels.js";
import { NOT_AN_AGENT_MESSAGE } from "./preconditions.js";
import { addRegistryMappings, readRegistryConfig } from "./registry-project.js";

export interface RegistryCommandLogger {
  error(message: string): void;
  log(message: string): void;
}

export interface AddCommandOptions {
  overwrite?: boolean;
}

export interface AddCommandDependencies {
  loadChannelsAddCommand(): Promise<typeof runChannelsAddCommand>;
}

const defaultAddCommandDependencies: AddCommandDependencies = {
  loadChannelsAddCommand: async () => (await import("./channels.js")).runChannelsAddCommand,
};

const OFFICIAL_REGISTRY = "https://eve.dev/r";
const OFFICIAL_CATALOG = `${OFFICIAL_REGISTRY}/registry.json`;

function isRegistryAddress(value: string): boolean {
  return value.startsWith("@") || /^https?:\/\//.test(value);
}

function itemAddress(item: string): string {
  return isRegistryAddress(item) ? item : `${OFFICIAL_REGISTRY}/${item}.json`;
}

const EveRegistryItemMetadataSchema = z.object({
  meta: z
    .object({
      eve: z
        .object({
          channel: z
            .enum(["slack", "web"], {
              error: (issue) =>
                `Unknown eve channel kind in registry metadata: ${String(issue.input)}`,
            })
            .optional(),
        })
        .optional(),
    })
    .optional(),
});

function channelKindFromRegistryItem(item: unknown): ChannelKind | undefined {
  return EveRegistryItemMetadataSchema.parse(item).meta?.eve?.channel;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runRegistryAction(
  logger: RegistryCommandLogger,
  appRoot: string,
  action: () => Promise<void>,
): Promise<void> {
  if (!(await isEveProject(appRoot))) {
    logger.error(NOT_AN_AGENT_MESSAGE);
    process.exitCode = 1;
    return;
  }

  try {
    await action();
  } catch (error) {
    logger.error(errorMessage(error));
    process.exitCode = 1;
  }
}

function configuredRegistrySources(config: RegistryConfig): string[] {
  return Object.keys(config.registries ?? {});
}

function validateRegistrySource(source: string | undefined): void {
  if (source !== undefined && !isRegistryAddress(source)) {
    throw new Error(`Registry sources must be a namespace or URL: ${source}`);
  }
}

function printSearchResults(
  logger: RegistryCommandLogger,
  result: Awaited<ReturnType<typeof searchRegistries>>,
  options: { query: string | undefined; sources: string[] },
): void {
  if (result.items.length === 0) {
    logger.log("No registry items found.");
    return;
  }

  const count = `${result.pagination.total} item${result.pagination.total === 1 ? "" : "s"}`;
  const query = options.query === undefined ? "" : ` matching "${options.query}"`;
  const registries = `${options.sources.length} registr${options.sources.length === 1 ? "y" : "ies"}`;
  logger.log(`Found ${count}${query} in ${registries}`);
  logger.log("");

  for (const item of result.items) {
    const address = item.registry === OFFICIAL_CATALOG ? item.name : item.addCommandArgument;
    const description =
      options.query === undefined && item.description ? ` — ${item.description}` : "";
    logger.log(`${address}${description}`);
  }
}

async function browseRegistryItems(
  logger: RegistryCommandLogger,
  appRoot: string,
  query: string | undefined,
  source: string | undefined,
): Promise<void> {
  validateRegistrySource(source);
  const config = await readRegistryConfig(appRoot);
  const sources = source ? [source] : [OFFICIAL_CATALOG, ...configuredRegistrySources(config)];
  const result = await searchRegistries(sources, {
    config,
    continueOnError: sources.length > 1,
    query,
  });
  const errors = result.errors ?? [];
  if (errors.length < sources.length) {
    printSearchResults(logger, result, { query, sources });
  }
  for (const error of errors) {
    logger.error(`${error.registry}: ${error.message}`);
  }
  if (errors.length > 0) process.exitCode = 1;
}

/** Installs an official, configured, or URL-addressed registry item. */
export async function runAddCommand(
  logger: RegistryCommandLogger,
  appRoot: string,
  item: string,
  options: AddCommandOptions,
  dependencies: AddCommandDependencies = defaultAddCommandDependencies,
): Promise<void> {
  await runRegistryAction(logger, appRoot, async () => {
    const config = await readRegistryConfig(appRoot);
    const address = itemAddress(item);
    const [registryItem] = await getRegistryItems([address], { config });
    const channelKind = channelKindFromRegistryItem(registryItem);
    if (channelKind !== undefined) {
      const runChannelsAddCommand = await dependencies.loadChannelsAddCommand();
      await runChannelsAddCommand(logger, appRoot, {
        kind: channelKind,
        options: {},
      });
      return;
    }

    await addRegistryItems([address], { ...options, config, cwd: appRoot });
  });
}

/** Adds registry namespace mappings to the project's package.json. */
export async function runRegistryAddCommand(
  logger: RegistryCommandLogger,
  appRoot: string,
  mappings: readonly string[],
): Promise<void> {
  await runRegistryAction(logger, appRoot, async () => {
    const result = await addRegistryMappings(appRoot, mappings);
    for (const namespace of result.skippedBuiltIn) {
      logger.log(`Skipped ${namespace} because it is built in.`);
    }
    for (const namespace of result.skippedExisting) {
      logger.log(`Skipped ${namespace} because it is already configured.`);
    }
    if (result.added.length > 0) {
      logger.log(`Added ${result.added.join(", ")} to package.json.`);
    }
  });
}

/** Lists registry items from every configured source or one selected source. */
export async function runRegistryListCommand(
  logger: RegistryCommandLogger,
  appRoot: string,
  source?: string,
): Promise<void> {
  await runRegistryAction(logger, appRoot, () =>
    browseRegistryItems(logger, appRoot, undefined, source),
  );
}

/** Searches registry items across every configured source or one selected source. */
export async function runRegistrySearchCommand(
  logger: RegistryCommandLogger,
  appRoot: string,
  query: string,
  source?: string,
): Promise<void> {
  await runRegistryAction(logger, appRoot, () =>
    browseRegistryItems(logger, appRoot, query, source),
  );
}

/** Prints one official, configured, or URL-addressed registry item as JSON. */
export async function runRegistryViewCommand(
  logger: RegistryCommandLogger,
  appRoot: string,
  item: string,
): Promise<void> {
  await runRegistryAction(logger, appRoot, async () => {
    const config = await readRegistryConfig(appRoot);
    const items = await getRegistryItems([itemAddress(item)], { config });
    logger.log(JSON.stringify(items.length === 1 ? items[0] : items, null, 2));
  });
}

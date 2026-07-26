import {
  addRegistryItems,
  getRegistryItems,
  searchRegistries,
  type RegistryConfig,
} from "#compiled/shadcn-registry/index.js";
import { isEveProject } from "#setup/scaffold/index.js";

import { NOT_AN_AGENT_MESSAGE } from "./preconditions.js";
import { addRegistryMappings, readRegistryConfig } from "./registry-project.js";

export interface RegistryCommandLogger {
  error(message: string): void;
  log(message: string): void;
}

export interface AddCommandOptions {
  overwrite?: boolean;
}

const OFFICIAL_REGISTRY = "https://eve.dev/r";
const OFFICIAL_CATALOG = `${OFFICIAL_REGISTRY}/registry.json`;

function isRegistryAddress(value: string): boolean {
  return value.startsWith("@") || /^https?:\/\//.test(value);
}

function itemAddress(item: string): string {
  return isRegistryAddress(item) ? item : `${OFFICIAL_REGISTRY}/${item}.json`;
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
  items: Array<{ addCommandArgument: string; description?: string }>,
): void {
  if (items.length === 0) {
    logger.log("No registry items found.");
    return;
  }
  for (const item of items) {
    logger.log(`${item.addCommandArgument}${item.description ? ` — ${item.description}` : ""}`);
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
  printSearchResults(logger, result.items);
  for (const error of result.errors ?? []) {
    logger.error(`${error.registry}: ${error.message}`);
  }
}

/** Installs an official, configured, or URL-addressed registry item. */
export async function runAddCommand(
  logger: RegistryCommandLogger,
  appRoot: string,
  item: string,
  options: AddCommandOptions,
): Promise<void> {
  await runRegistryAction(logger, appRoot, async () => {
    await addRegistryItems([itemAddress(item)], { ...options, cwd: appRoot });
  });
}

/** Adds registry namespace mappings to the project's components.json. */
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
      logger.log(`Added ${result.added.join(", ")} to components.json.`);
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

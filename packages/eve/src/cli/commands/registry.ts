import {
  addRegistryItems,
  getRegistryItems,
  searchRegistries,
  type RegistryConfig,
  type RegistrySearchItem,
} from "#compiled/shadcn-registry/index.js";
import semver from "#compiled/semver/index.js";
import { z } from "#compiled/zod/index.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { createPrompter, type Prompter } from "#setup/prompter.js";
import { isEveProject } from "#setup/scaffold/index.js";
import { WizardCancelledError } from "#setup/step.js";

import { NOT_AN_AGENT_MESSAGE } from "./preconditions.js";
import type { runRegistrySetupCommand } from "./registry-setup-command.js";
import { addRegistryMappings, readRegistryConfig } from "./registry-project.js";

export interface RegistryCommandLogger {
  error(message: string): void;
  log(message: string): void;
}

export interface AddCommandOptions {
  skipInstall?: boolean;
  overwrite?: boolean;
  skipSetup?: boolean;
  yes?: boolean;
  /** Suppresses the registry SDK's terminal-native progress output. */
  silent?: boolean;
}

type SetupCommandOptions = Pick<AddCommandOptions, "yes"> & {
  prompter?: Prompter;
  signal?: AbortSignal;
};

export interface RegistrySetupDependencies {
  loadSetupCommandRunner(): Promise<typeof runRegistrySetupCommand>;
}

export interface AddCommandDependencies extends RegistrySetupDependencies {
  createPrompter?: () => Prompter;
  isInteractive?: () => boolean;
}

/** One discoverable item from an eve-compatible registry catalog. */
export interface RegistryCatalogItem {
  address: string;
  name: string;
  title?: string;
  type?: string;
  description?: string;
  source: string;
}

/** Catalog items plus non-fatal failures from the registry sources queried. */
export interface RegistryCatalogResult {
  items: RegistryCatalogItem[];
  total: number;
  errors: Array<{ message: string; registry: string }>;
}

const defaultAddCommandDependencies: AddCommandDependencies = {
  createPrompter,
  isInteractive: () => process.stdin.isTTY === true && process.stdout.isTTY === true,
  loadSetupCommandRunner: async () =>
    (await import("./registry-setup-command.js")).runRegistrySetupCommand,
};

const OFFICIAL_REGISTRY = process.env.EVE_DEV_OFFICIAL_REGISTRY_URL ?? "https://eve.dev/r";
const OFFICIAL_CATALOG = `${OFFICIAL_REGISTRY}/registry.json`;

// shadcn's registry search response omits titles. Keep this one exception until it includes them.
const OFFICIAL_CATALOG_TITLES = new Map([["channel/photon-imessage", "Photon iMessage"]]);

function isRegistryAddress(value: string): boolean {
  return value.startsWith("@") || /^https?:\/\//.test(value);
}

function itemAddress(item: string): string {
  return isRegistryAddress(item) ? item : `${OFFICIAL_REGISTRY}/${item}.json`;
}

/** Installs an official registry item without running its declared setup command. */
export async function installOfficialRegistryItem(
  appRoot: string,
  item: string,
  options: AddCommandOptions = {},
): Promise<void> {
  const config = await readRegistryConfig(appRoot);
  await addRegistryItems([itemAddress(item)], {
    config,
    cwd: appRoot,
    overwrite: options.overwrite,
  });
}

const EveRegistryItemMetadataSchema = z.object({
  meta: z
    .object({
      eve: z
        .object({
          requires: z.string().optional(),
          setup: z
            .object({
              package: z.string().min(1),
              bin: z.string().min(1),
              args: z.array(z.string()).default([]),
            })
            .optional(),
        })
        .optional(),
    })
    .optional(),
});

function eveMetadataFromRegistryItem(item: unknown) {
  return EveRegistryItemMetadataSchema.parse(item).meta?.eve;
}

function setupResumeCommand(item: string): string {
  const argument = /^[\w@./:-]+$/.test(item) ? item : `'${item.replaceAll("'", `'\\''`)}'`;
  return `eve add ${argument} --skip-install`;
}

function setupReminder(item: string, outcome: "cancelled" | "skipped"): string {
  const action = outcome === "cancelled" ? "Setup cancelled." : "Setup skipped.";
  return `${action} Run \`${setupResumeCommand(item)}\` when you're ready.`;
}

function assertCompatibleEveVersion(requiredVersion: string | undefined): void {
  if (requiredVersion === undefined) return;
  const installedVersion = resolveInstalledPackageInfo().version;
  if (semver.validRange(requiredVersion) === null) {
    throw new Error(`Registry item has an invalid eve version requirement: ${requiredVersion}.`);
  }
  if (semver.subset(installedVersion, requiredVersion)) return;
  throw new Error(
    `This registry item requires eve ${requiredVersion}, but this project is using eve ${installedVersion}. Upgrade eve and run the command again.`,
  );
}

function isOfficialItemAddress(address: string): boolean {
  return address.startsWith(`${OFFICIAL_REGISTRY}/`);
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

async function searchRegistryCatalog(
  appRoot: string,
  options: { query?: string; source?: string },
) {
  validateRegistrySource(options.source);
  const config = await readRegistryConfig(appRoot);
  const sources = options.source
    ? [options.source]
    : [OFFICIAL_CATALOG, ...configuredRegistrySources(config)];
  const result = await searchRegistries(sources, {
    config,
    continueOnError: sources.length > 1,
    query: options.query,
  });
  return { result, sources };
}

/** Browses all configured catalogs, or one namespace or URL source. */
export async function browseRegistryCatalog(
  appRoot: string,
  options: { query?: string; source?: string } = {},
): Promise<RegistryCatalogResult> {
  const { result } = await searchRegistryCatalog(appRoot, options);
  return {
    items: result.items.map((item: RegistrySearchItem) => {
      const catalogItem: RegistryCatalogItem = {
        address: item.registry === OFFICIAL_CATALOG ? item.name : item.addCommandArgument,
        name: item.name,
        source: item.registry === OFFICIAL_CATALOG ? "Vercel" : item.registry,
      };
      const title = OFFICIAL_CATALOG_TITLES.get(item.name);
      if (title !== undefined && item.registry === OFFICIAL_CATALOG) catalogItem.title = title;
      if (item.type !== undefined) catalogItem.type = item.type;
      if (item.description !== undefined) catalogItem.description = item.description;
      return catalogItem;
    }),
    total: result.pagination.total,
    errors: result.errors ?? [],
  };
}

async function browseRegistryItems(
  logger: RegistryCommandLogger,
  appRoot: string,
  query: string | undefined,
  source: string | undefined,
): Promise<void> {
  const { result, sources } = await searchRegistryCatalog(appRoot, { query, source });
  const errors = result.errors ?? [];
  if (errors.length < sources.length) {
    printSearchResults(logger, result, { query, sources });
  }
  for (const error of errors) {
    logger.error(`${error.registry}: ${error.message}`);
  }
  if (errors.length > 0) process.exitCode = 1;
}

/** Resolves one official, configured, or URL-addressed item manifest. */
export async function getRegistryItemManifest(appRoot: string, item: string): Promise<unknown> {
  const config = await readRegistryConfig(appRoot);
  const items = await getRegistryItems([itemAddress(item)], { config });
  return items.length === 1 ? items[0] : items;
}

async function runDeclaredSetup(
  logger: RegistryCommandLogger,
  appRoot: string,
  item: string,
  setup: NonNullable<ReturnType<typeof eveMetadataFromRegistryItem>>["setup"],
  options: SetupCommandOptions,
  dependencies: RegistrySetupDependencies,
): Promise<void> {
  if (setup === undefined) return;
  const runSetupCommand = await dependencies.loadSetupCommandRunner();
  try {
    const prompter = options.prompter ?? createPrompter();
    const result = await runSetupCommand(
      appRoot,
      { ...setup, args: [...setup.args, ...(options.yes ? ["--yes"] : [])] },
      item,
      { prompter, signal: options.signal },
    );
    if (result.kind === "cancelled") {
      logger.log(setupReminder(item, "cancelled"));
    } else {
      for (const line of result.output) logger.log(line);
    }
  } catch (error) {
    throw new Error(`${errorMessage(error)} Try again with \`${setupResumeCommand(item)}\`.`);
  }
}

/** Installs an official, configured, or URL-addressed registry item. */
export async function installRegistryItem(
  appRoot: string,
  item: string,
  options: AddCommandOptions & { prompter?: Prompter; signal?: AbortSignal } = {},
  dependencies: AddCommandDependencies = defaultAddCommandDependencies,
): Promise<readonly string[]> {
  let failure: string | undefined;
  const output: string[] = [];
  const logger: RegistryCommandLogger = {
    error: (message) => {
      failure = message;
    },
    log: (message) => output.push(message),
  };
  const previousExitCode = process.exitCode;
  await runAddCommand(logger, appRoot, item, { ...options, yes: true }, dependencies);
  process.exitCode = previousExitCode;
  if (failure !== undefined) throw new Error(failure);
  return output;
}

/** Installs an official, configured, or URL-addressed registry item. */
export async function runAddCommand(
  logger: RegistryCommandLogger,
  appRoot: string,
  item: string,
  options: AddCommandOptions & { prompter?: Prompter; signal?: AbortSignal },
  dependencies: AddCommandDependencies = defaultAddCommandDependencies,
): Promise<void> {
  await runRegistryAction(logger, appRoot, async () => {
    const config = await readRegistryConfig(appRoot);
    const address = itemAddress(item);
    if (options.skipInstall === true) {
      if (options.overwrite === true) {
        throw new Error("--overwrite cannot be used with --skip-install.");
      }
      if (options.skipSetup === true) {
        throw new Error("--skip-install cannot be used with --skip-setup.");
      }
      if (!isOfficialItemAddress(address)) {
        throw new Error(
          "Setup flows are currently supported only for official eve registry items.",
        );
      }
    }
    const [registryItem] = await getRegistryItems([address], { config });
    const eveMetadata = isOfficialItemAddress(address)
      ? eveMetadataFromRegistryItem(registryItem)
      : undefined;
    assertCompatibleEveVersion(eveMetadata?.requires);

    if (options.skipInstall === true) {
      if (eveMetadata?.setup === undefined) {
        throw new Error(`Registry item "${item}" does not declare a setup flow.`);
      }
      await runDeclaredSetup(logger, appRoot, item, eveMetadata.setup, options, dependencies);
      return;
    }

    await addRegistryItems([address], {
      config,
      cwd: appRoot,
      overwrite: options.overwrite,
      silent: options.silent,
    });
    if (eveMetadata?.setup === undefined) return;

    const isInteractive =
      dependencies.isInteractive?.() ?? defaultAddCommandDependencies.isInteractive!();
    if (options.skipSetup === true || (!options.yes && !isInteractive)) {
      logger.log(setupReminder(item, "skipped"));
      return;
    }

    if (!options.yes) {
      try {
        const prompter =
          dependencies.createPrompter?.() ?? defaultAddCommandDependencies.createPrompter!();
        const shouldRun = await prompter.select({
          message: `Set up ${item} now?`,
          initialValue: "yes",
          options: [
            { value: "yes", label: "Yes" },
            { value: "no", label: "No" },
          ],
        });
        if (shouldRun === "no") {
          logger.log(setupReminder(item, "skipped"));
          return;
        }
      } catch (error) {
        if (!(error instanceof WizardCancelledError)) throw error;
        logger.log(setupReminder(item, "cancelled"));
        return;
      }
    }

    await runDeclaredSetup(logger, appRoot, item, eveMetadata.setup, options, dependencies);
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

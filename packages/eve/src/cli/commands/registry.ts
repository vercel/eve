import {
  addRegistryItems,
  getRegistryItems,
  searchRegistries,
  type RegistryConfig,
  type RegistrySearchItem,
} from "#compiled/shadcn-registry/index.js";
import semver from "#compiled/semver/index.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { createPrompter, type Prompter } from "#setup/prompter.js";
import type { RegistrySetupCompletion } from "#setup/registry-setup-protocol.js";
import { WizardCancelledError } from "#setup/step.js";

import { hasInteractiveTerminal } from "./preconditions.js";
import {
  registryInstallFailureCode,
  registryInstallFailureMessage,
  rollbackRegistryInstall,
  snapshotRegistryInstall,
} from "./registry-install-transaction.js";
import { runDeclaredSetups } from "./registry-declared-setups.js";
import {
  errorMessage,
  resolveRegistryItemForAdd,
  runRegistryAction,
  setupReminder,
  setupResumeCommand,
  type RegistryCommandLogger,
} from "./registry-recovery.js";
import {
  eveMetadataFromRegistryItem,
  parseOfficialRegistrySearchMetadata,
  type RegistrySearchMetadata,
} from "./registry-metadata.js";
import { runRegistryPackage } from "./registry-package.js";
import {
  printRegistrySearchResults,
  registryViewText,
  type RegistrySearchPresentationItem,
  type RegistrySearchPresentationSection,
} from "./registry-presentation.js";
import type { runRegistrySetupCommand } from "./registry-setup-command.js";
import {
  reportHeadlessSetupCompletion,
  serializeHeadlessSetupEvent,
  type HeadlessSetupEvent,
} from "./setup-headless.js";
import {
  addRegistryMappings,
  prepareWebRegistryProject,
  readRegistryConfig,
} from "./registry-project.js";
export type { RegistryCommandLogger } from "./registry-recovery.js";
export interface AddCommandOptions {
  skipInstall?: boolean;
  overwrite?: boolean;
  skipSetup?: boolean;
  yes?: boolean;
  nonInteractive?: boolean;
  answers?: Record<string, unknown>;
  /** Suppresses the registry SDK's terminal-native progress output. */
  silent?: boolean;
}

/** Options shared by registry catalog commands. */
export interface RegistryCommandOptions {
  /** Emit the underlying registry result as JSON. */
  json?: boolean;
}

/** Options for searching registry catalogs. */
export interface RegistrySearchCommandOptions extends RegistryCommandOptions {
  /** Maximum number of matching items to return. */
  limit?: number;
}

export interface RegistrySetupDependencies {
  loadSetupCommandRunner(): Promise<typeof runRegistrySetupCommand>;
}

export interface AddCommandDependencies extends RegistrySetupDependencies {
  createPrompter?: () => Prompter;
  hasInteractiveTerminal?: () => boolean;
  prepareWebRegistryProject?: typeof prepareWebRegistryProject;
}

type RunAddCommandOptions = AddCommandOptions & {
  prompter?: Prompter;
  signal?: AbortSignal;
  setupAuthorized?: boolean;
};

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
  hasInteractiveTerminal,
  loadSetupCommandRunner: async () =>
    (await import("./registry-setup-command.js")).runRegistrySetupCommand,
  prepareWebRegistryProject,
};

const DEFAULT_OFFICIAL_REGISTRY_URL = "https://eve.dev/r";

/**
 * Resolves the official registry URL, honoring the explicit development trust override.
 *
 * The override makes its registry eligible to supply setup commands, so it must be
 * configured in the process environment rather than project configuration.
 */
export function resolveOfficialRegistryUrl(
  configured = process.env.EVE_DEV_OFFICIAL_REGISTRY_URL,
): string {
  if (configured === undefined) return DEFAULT_OFFICIAL_REGISTRY_URL;

  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error("EVE_DEV_OFFICIAL_REGISTRY_URL must be an HTTP(S) URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("EVE_DEV_OFFICIAL_REGISTRY_URL must be an HTTP(S) URL.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("EVE_DEV_OFFICIAL_REGISTRY_URL must not include credentials.");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new Error("EVE_DEV_OFFICIAL_REGISTRY_URL must not include a query or fragment.");
  }

  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

const OFFICIAL_REGISTRY = resolveOfficialRegistryUrl();
const OFFICIAL_CATALOG = `${OFFICIAL_REGISTRY}/registry.json`;
const SKILLS_REGISTRY = "@skills";
const SKILLS_REGISTRY_URL = "https://www.skills.sh/r/{name}?agent=eve";
const CATALOG_PAGE_SIZE = 100;
const DEFAULT_SEARCH_LIMIT = 10;
const ADD_SUGGESTION_LIMIT = 5;

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
  const config = await readEveRegistryConfig(appRoot);
  await addRegistryItems([itemAddress(item)], {
    config,
    cwd: appRoot,
    overwrite: options.overwrite,
  });
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

function withBuiltInRegistries(config: RegistryConfig): RegistryConfig {
  return {
    ...config,
    registries: { [SKILLS_REGISTRY]: SKILLS_REGISTRY_URL, ...config.registries },
  };
}

async function readEveRegistryConfig(appRoot: string): Promise<RegistryConfig> {
  return withBuiltInRegistries(await readRegistryConfig(appRoot));
}

function configuredRegistrySources(config: RegistryConfig): string[] {
  return Object.keys(config.registries ?? {});
}

function validateRegistrySource(source: string | undefined): void {
  if (source !== undefined && !isRegistryAddress(source)) {
    throw new Error(`Registry sources must be a namespace or URL: ${source}`);
  }
}

type RegistrySearchResult = Awaited<ReturnType<typeof searchRegistries>>;

async function loadOfficialSearchMetadata(): Promise<ReadonlyMap<string, RegistrySearchMetadata>> {
  const response = await fetch(OFFICIAL_CATALOG);
  if (!response.ok) throw new Error(`Could not read the eve registry (${response.status}).`);
  return parseOfficialRegistrySearchMetadata(await response.json());
}

function searchItemAddress(item: RegistrySearchItem): string {
  return item.registry === OFFICIAL_CATALOG ? item.name : item.addCommandArgument;
}

function enrichSearchItem(
  item: RegistrySearchItem,
  metadataByAddress: ReadonlyMap<string, RegistrySearchMetadata>,
): RegistrySearchPresentationItem {
  const address = searchItemAddress(item);
  return { item, address, ...metadataByAddress.get(address) };
}

function registrySourceLabel(source: string): string {
  if (source === OFFICIAL_CATALOG) return "eve";
  if (source === SKILLS_REGISTRY) return "skills.sh";
  return source;
}

function searchPresentationSections(
  sources: readonly string[],
  resultsBySource: ReadonlyMap<string, RegistrySearchResult>,
  metadataByAddress: ReadonlyMap<string, RegistrySearchMetadata>,
): RegistrySearchPresentationSection[] {
  return sources.flatMap((source) => {
    const result = resultsBySource.get(source);
    return result === undefined
      ? []
      : [
          {
            label: registrySourceLabel(source),
            items: result.items.map((item) => enrichSearchItem(item, metadataByAddress)),
            total: result.pagination.total,
          },
        ];
  });
}

async function printAddSuggestions(
  logger: RegistryCommandLogger,
  appRoot: string,
  item: string,
): Promise<void> {
  try {
    const query = item.split("/").at(-1) || item;
    const { resultsBySource, sources, metadataByAddress } = await searchRegistryCatalog(appRoot, {
      limit: ADD_SUGGESTION_LIMIT,
      query,
    });
    const sections = searchPresentationSections(sources, resultsBySource, metadataByAddress);
    if (sections.every((section) => section.items.length === 0)) return;

    logger.log("Did you mean?");
    printRegistrySearchResults(logger, { query, sections });
  } catch {
    // The original not-found error remains actionable when catalog search is unavailable.
  }
}

async function searchRegistryCatalog(
  appRoot: string,
  options: { limit?: number; query?: string; source?: string },
) {
  validateRegistrySource(options.source);
  const config = await readEveRegistryConfig(appRoot);
  const sources = options.source
    ? [options.source]
    : [
        OFFICIAL_CATALOG,
        ...configuredRegistrySources(config).filter(
          (source) => options.query !== undefined || source !== SKILLS_REGISTRY,
        ),
      ];
  const responses = await Promise.all(
    sources.map(async (source) => {
      try {
        return {
          result: await searchRegistries([source], {
            config,
            limit: options.limit ?? CATALOG_PAGE_SIZE,
            query: options.query,
          }),
          source,
        };
      } catch (error) {
        return { error, source };
      }
    }),
  );
  const errors: NonNullable<RegistrySearchResult["errors"]> = [];
  const resultsBySource = new Map<string, RegistrySearchResult>();
  for (const response of responses) {
    if ("error" in response) {
      errors.push({ message: errorMessage(response.error), registry: response.source });
    } else {
      const sourceErrors = response.result.errors ?? [];
      errors.push(...sourceErrors);
      if (sourceErrors.length === 0) {
        const items = response.result.items.filter((item) => item.registry === response.source);
        resultsBySource.set(response.source, {
          ...response.result,
          items,
          pagination: {
            ...response.result.pagination,
            total:
              response.result.items.length === items.length ? response.result.pagination.total : 0,
          },
        });
      }
    }
  }
  const uniqueErrors = new Map(
    errors.map((error) => [`${error.registry}\0${error.message}`, error]),
  );
  const metadataByAddress = resultsBySource.has(OFFICIAL_CATALOG)
    ? await loadOfficialSearchMetadata()
    : new Map<string, RegistrySearchMetadata>();
  const official = resultsBySource.get(OFFICIAL_CATALOG);
  if (official !== undefined) {
    official.items.sort((left, right) => {
      const rank = (item: RegistrySearchItem) =>
        metadataByAddress.get(searchItemAddress(item))?.implementation === "native" ? 0 : 1;
      return rank(left) - rank(right);
    });
  }
  const results = [...resultsBySource.values()];
  const result: RegistrySearchResult = {
    items: results.flatMap((entry) => entry.items),
    pagination: {
      hasMore: results.some((entry) => entry.pagination.hasMore),
      limit: options.limit ?? CATALOG_PAGE_SIZE,
      offset: 0,
      total: results.reduce((total, entry) => total + entry.pagination.total, 0),
    },
    ...(uniqueErrors.size > 0 ? { errors: [...uniqueErrors.values()] } : {}),
  };
  return { config, result, resultsBySource, sources, metadataByAddress };
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
      if (item.title !== undefined) catalogItem.title = item.title;
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
  options: RegistrySearchCommandOptions = {},
): Promise<void> {
  const { result, resultsBySource, sources, metadataByAddress } = await searchRegistryCatalog(
    appRoot,
    {
      limit: options.limit,
      query,
      source,
    },
  );
  const errors = result.errors ?? [];
  if (options.json || resultsBySource.size > 0) {
    const items = result.items.map((item) => ({
      ...item,
      ...metadataByAddress.get(searchItemAddress(item)),
    }));
    const presentation: Parameters<typeof printRegistrySearchResults>[1] = {
      query,
      sections: searchPresentationSections(sources, resultsBySource, metadataByAddress),
    };
    if (options.json) presentation.json = { ...result, items };
    printRegistrySearchResults(logger, presentation);
  }
  for (const error of errors) {
    logger.error(`${error.registry}: ${error.message}`);
  }
  if (errors.length > 0) process.exitCode = 1;
}

/** Resolves one official, configured, or URL-addressed item manifest. */
export async function getRegistryItemManifest(appRoot: string, item: string): Promise<unknown> {
  const config = await readEveRegistryConfig(appRoot);
  const items = await getRegistryItems([itemAddress(item)], { config });
  return items.length === 1 ? items[0] : items;
}

/** Installs an official, configured, or URL-addressed registry item. */
export async function installRegistryItem(
  appRoot: string,
  item: string,
  options: AddCommandOptions & { prompter?: Prompter; signal?: AbortSignal } = {},
  dependencies: AddCommandDependencies = defaultAddCommandDependencies,
): Promise<{ output: readonly string[]; setup?: RegistrySetupCompletion }> {
  let failure: string | undefined;
  const output: string[] = [];
  const logger: RegistryCommandLogger = {
    error: (message) => {
      failure = message;
    },
    log: (message) => output.push(message),
  };
  const previousExitCode = process.exitCode;
  const setup = await runAddCommand(
    logger,
    appRoot,
    item,
    {
      ...options,
      yes: options.prompter === undefined ? true : options.yes,
      setupAuthorized: options.prompter !== undefined,
    },
    dependencies,
  );
  process.exitCode = previousExitCode;
  if (failure !== undefined) throw new Error(failure);
  const result: { output: readonly string[]; setup?: RegistrySetupCompletion } = { output };
  if (setup !== undefined) result.setup = setup;
  return result;
}

/** Installs an official, configured, or URL-addressed registry item. */
export async function runAddCommand(
  logger: RegistryCommandLogger,
  appRoot: string,
  item: string,
  options: RunAddCommandOptions,
  dependencies: AddCommandDependencies = defaultAddCommandDependencies,
): Promise<RegistrySetupCompletion | undefined> {
  return runRegistryAction(logger, appRoot, async () => {
    const config = await readEveRegistryConfig(appRoot);
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
    const registryItemResult = await resolveRegistryItemForAdd(
      logger,
      async () => (await getRegistryItems([address], { config }))[0],
      () => printAddSuggestions(logger, appRoot, item),
    );
    if (!registryItemResult.found) return;
    const registryItem = registryItemResult.item;
    const eveMetadata = isOfficialItemAddress(address)
      ? eveMetadataFromRegistryItem(registryItem)
      : undefined;
    assertCompatibleEveVersion(eveMetadata?.requires);

    if (eveMetadata?.components !== undefined) {
      if (!isOfficialItemAddress(address))
        throw new Error("Registry packages require the official eve registry.");
      const completion = await runRegistryPackage({
        logger,
        appRoot,
        item,
        components: eveMetadata.components,
        config,
        options,
        dependencies,
        operations: {
          itemAddress,
          metadata: eveMetadataFromRegistryItem,
          assertCompatibleVersion: assertCompatibleEveVersion,
          runSetups: ({ item: packageItem, setups, prompter }) =>
            runDeclaredSetups({
              logger,
              appRoot,
              item: packageItem,
              setups,
              options: {
                yes: options.yes,
                nonInteractive: options.nonInteractive,
                answers: options.answers,
                prompter,
                signal: options.signal,
              },
              dependencies,
              cancelledReminder: setupReminder(packageItem, "cancelled"),
              resumeCommand: setupResumeCommand(packageItem),
            }),
          setupReminder: (packageItem) => setupReminder(packageItem, "skipped"),
        },
      });
      return reportCompletion(logger, item, completion, options);
    }

    if (options.skipInstall === true) {
      if (eveMetadata?.setup === undefined) {
        throw new Error(`Registry item "${item}" does not declare a setup flow.`);
      }
      const completion = await runDeclaredSetups({
        logger,
        appRoot,
        item,
        setups: eveMetadata.setup,
        options,
        dependencies,
        cancelledReminder: setupReminder(item, "cancelled"),
        resumeCommand: setupResumeCommand(item),
      });
      return reportCompletion(logger, item, completion, options);
    }

    if (address === itemAddress("channel/web")) {
      await (dependencies.prepareWebRegistryProject ?? prepareWebRegistryProject)(appRoot);
    }
    const installSnapshot = await snapshotRegistryInstall(appRoot, registryItem);
    try {
      await addRegistryItems([address], {
        config,
        cwd: appRoot,
        overwrite: options.overwrite,
        silent: options.silent,
      });
    } catch (error) {
      const rollback = await rollbackRegistryInstall(appRoot, installSnapshot);
      const failureCode = registryInstallFailureCode(error);
      const message = registryInstallFailureMessage(failureCode);
      if (options.nonInteractive) {
        const failureEvent: Extract<HeadlessSetupEvent, { type: "failed" }> = {
          version: 1,
          type: "failed",
          item,
          completedItems: [],
          message,
          failureCode,
          rolledBack: rollback.restored,
        };
        if (rollback.changed.length > 0) failureEvent.changed = rollback.changed;
        logger.log(serializeHeadlessSetupEvent(failureEvent));
      }
      throw new Error(message, { cause: error });
    }
    if (eveMetadata?.setup === undefined)
      return reportCompletion(logger, item, { facts: [] }, options);

    const interactive =
      dependencies.hasInteractiveTerminal?.() ??
      defaultAddCommandDependencies.hasInteractiveTerminal!();
    if (options.nonInteractive) {
      logger.log(
        serializeHeadlessSetupEvent({
          version: 1,
          type: "progress",
          message: options.skipInstall ? `Setup ${item}` : `Installed ${item}`,
        }),
      );
    }
    if (options.skipSetup === true) {
      if (options.nonInteractive) return reportCompletion(logger, item, { facts: [] }, options);
      logger.log(setupReminder(item, "skipped"));
      return;
    }
    if (
      !options.nonInteractive &&
      !options.yes &&
      !interactive &&
      options.setupAuthorized !== true
    ) {
      logger.log(setupReminder(item, "skipped"));
      return;
    }

    if (!options.nonInteractive && !options.yes && options.setupAuthorized !== true) {
      try {
        const prompter =
          options.prompter ??
          dependencies.createPrompter?.() ??
          defaultAddCommandDependencies.createPrompter!();
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

    const completion = await runDeclaredSetups({
      logger,
      appRoot,
      item,
      setups: eveMetadata.setup,
      options,
      dependencies,
      cancelledReminder: setupReminder(item, "cancelled"),
      resumeCommand: setupResumeCommand(item),
    });
    return reportCompletion(logger, item, completion, options);
  });
}
function reportCompletion(
  logger: RegistryCommandLogger,
  item: string,
  completion: RegistrySetupCompletion | false,
  options: AddCommandOptions,
): RegistrySetupCompletion | undefined {
  return reportHeadlessSetupCompletion({
    logger,
    item,
    completion,
    nonInteractive: options.nonInteractive,
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
  options: RegistryCommandOptions = {},
): Promise<void> {
  await runRegistryAction(logger, appRoot, () =>
    browseRegistryItems(logger, appRoot, undefined, source, options),
  );
}

/** Searches registry items across every configured source or one selected source. */
export async function runRegistrySearchCommand(
  logger: RegistryCommandLogger,
  appRoot: string,
  query: string,
  source?: string,
  options: RegistrySearchCommandOptions = {},
): Promise<void> {
  await runRegistryAction(logger, appRoot, () =>
    browseRegistryItems(logger, appRoot, query, source, {
      ...options,
      limit: options.limit ?? DEFAULT_SEARCH_LIMIT,
    }),
  );
}

/** Inspects one official, configured, or URL-addressed registry item. */
export async function runRegistryViewCommand(
  logger: RegistryCommandLogger,
  appRoot: string,
  item: string,
  options: RegistryCommandOptions = {},
): Promise<void> {
  await runRegistryAction(logger, appRoot, async () => {
    const config = await readEveRegistryConfig(appRoot);
    const items = await getRegistryItems([itemAddress(item)], { config });
    const result = items.length === 1 ? items[0] : items;
    logger.log(options.json ? JSON.stringify(result, null, 2) : registryViewText(item, result));
  });
}

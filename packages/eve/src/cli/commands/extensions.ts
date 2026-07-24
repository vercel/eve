import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { isEveProject } from "#setup/scaffold/index.js";
import { runShadcn } from "#setup/primitives/run-shadcn.js";

import { NOT_AN_AGENT_MESSAGE } from "./preconditions.js";

export interface RegistryCommandLogger {
  error(message: string): void;
  log(message: string): void;
}

const OFFICIAL_REGISTRY = "https://eve.dev/r";
const OFFICIAL_CATALOG = `${OFFICIAL_REGISTRY}/registry.json`;

function isRegistryAddress(value: string): boolean {
  return value.startsWith("@") || /^https?:\/\//.test(value);
}

function itemAddress(item: string): string {
  return isRegistryAddress(item) ? item : `${OFFICIAL_REGISTRY}/${item}.json`;
}

async function runRegistryCommand(
  logger: RegistryCommandLogger,
  appRoot: string,
  args: readonly string[],
): Promise<void> {
  if (!(await isEveProject(appRoot))) {
    logger.error(NOT_AN_AGENT_MESSAGE);
    process.exitCode = 1;
    return;
  }
  if (!(await runShadcn(args, { cwd: appRoot }))) {
    logger.error("shadcn command failed.");
    process.exitCode = 1;
  }
}

/** Installs a registry item, using eve's official registry for a bare slug. */
export async function runAddCommand(
  logger: RegistryCommandLogger,
  appRoot: string,
  item: string,
  flags: readonly string[],
): Promise<void> {
  await runRegistryCommand(logger, appRoot, ["add", itemAddress(item), ...flags]);
}

/** Forwards project registry configuration to shadcn. */
export async function runRegistryConfigurationCommand(
  logger: RegistryCommandLogger,
  appRoot: string,
  args: readonly string[],
): Promise<void> {
  await runRegistryCommand(logger, appRoot, ["registry", ...args]);
}

/** Lists, searches, or views one registry catalog through shadcn. */
async function configuredRegistrySources(appRoot: string): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(appRoot, "components.json"), "utf8"));
    if (typeof parsed !== "object" || parsed === null || !("registries" in parsed)) return [];
    const registries = (parsed as { registries?: unknown }).registries;
    if (typeof registries !== "object" || registries === null) return [];
    return Object.keys(registries).filter((name) => name.startsWith("@"));
  } catch {
    return [];
  }
}

/** Lists and searches every configured registry by default, or one explicit source. */
export async function runRegistryBrowseCommand(
  logger: RegistryCommandLogger,
  appRoot: string,
  command: "list" | "search" | "view",
  args: readonly string[],
): Promise<void> {
  const values = [...args];
  if (command === "view") {
    const item = values.shift();
    if (item === undefined) throw new Error("Pass a registry item to view.");
    await runRegistryCommand(logger, appRoot, [command, itemAddress(item), ...values]);
    return;
  }

  const explicitSource = isRegistryAddress(values[0] ?? "") ? values.shift() : undefined;
  const sources =
    explicitSource === undefined
      ? [OFFICIAL_CATALOG, ...(await configuredRegistrySources(appRoot))]
      : [explicitSource];
  const query = command === "search" ? values.shift() : undefined;
  if (command === "search" && query === undefined) throw new Error("Pass a search query.");

  for (const source of sources) {
    if (sources.length > 1) logger.log(`\n${source === OFFICIAL_CATALOG ? "@eve" : source}`);
    const commandArgs =
      command === "search"
        ? [command, source, "--query", query!, ...values]
        : [command, source, ...values];
    await runRegistryCommand(logger, appRoot, commandArgs);
  }
}

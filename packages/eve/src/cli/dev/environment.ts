import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";

import { resolveEveProjectContext } from "#internal/project-context.js";
import { isObject } from "#shared/guards.js";
import { readProviderSelectionSync } from "#setup/provider-settings.js";

/**
 * Development environment files loaded by local CLI commands such as
 * `eve dev`, `eve build`, and `eve eval`, ordered from highest to lowest
 * precedence.
 */
export const DEVELOPMENT_ENV_FILE_NAMES = [
  ".env.development.local",
  ".env.local",
  ".env.development",
  ".env",
] as const;

function isMissingEnvironmentFileError(error: unknown): error is NodeJS.ErrnoException {
  return isObject(error) && error.code === "ENOENT";
}

interface DevelopmentEnvironmentLoader {
  readonly environmentRoots: readonly string[];
  reload(): void;
  stageReload(): DevelopmentEnvironmentReload;
}

export interface DevelopmentEnvironmentReload {
  commit(): void;
  rollback(): void;
}

const developmentEnvironmentLoaders = new Map<string, DevelopmentEnvironmentLoader>();

/**
 * Returns the local development environment files eve loads from an
 * application root, ordered from highest to lowest precedence.
 */
export function getDevelopmentEnvironmentFilePaths(appRoot: string): string[] {
  return [...getDevelopmentEnvironmentLoader(appRoot).environmentRoots]
    .reverse()
    .flatMap((root) => DEVELOPMENT_ENV_FILE_NAMES.map((fileName) => join(root, fileName)));
}

/**
 * Loads or reloads local development environment files from the application
 * root.
 *
 * Variables that existed before the first load keep parent-process
 * precedence. Variables supplied by env files are refreshed on subsequent
 * reloads so dev-mode file watching can pick up changed values.
 */
export async function loadDevelopmentEnvironmentFiles(appRoot: string): Promise<void> {
  const resolvedAppRoot = resolve(appRoot);
  const context = await resolveEveProjectContext(resolvedAppRoot);
  getDevelopmentEnvironmentLoader(resolvedAppRoot, context.environmentRoots).reload();
}

export function stageDevelopmentEnvironmentFiles(appRoot: string): DevelopmentEnvironmentReload {
  return getDevelopmentEnvironmentLoader(appRoot).stageReload();
}

export function readDevelopmentEnvironmentHostValues(
  appRoot: string,
): Readonly<Record<string, string | null>> {
  const values: Record<string, string | null> = {};
  const fileValues = readDevelopmentEnvironmentValues(
    getDevelopmentEnvironmentLoader(appRoot).environmentRoots,
  );
  const hostKeys = new Set(fileValues.keys());
  // Project selection can suppress a shell-only key. Keep that transition in
  // the host fingerprint so the worker that inherited the key is replaced.
  hostKeys.add("AI_GATEWAY_API_KEY");

  for (const key of [...hostKeys].sort((left, right) => left.localeCompare(right))) {
    values[key] = process.env[key] ?? null;
  }

  return values;
}

function getDevelopmentEnvironmentLoader(
  appRoot: string,
  environmentRoots?: readonly string[],
): DevelopmentEnvironmentLoader {
  const resolvedAppRoot = resolve(appRoot);
  const existingLoader = developmentEnvironmentLoaders.get(resolvedAppRoot);
  if (existingLoader !== undefined && environmentRoots === undefined) return existingLoader;

  const resolvedEnvironmentRoots = environmentRoots ?? [resolvedAppRoot];
  if (
    existingLoader !== undefined &&
    existingLoader.environmentRoots.length === resolvedEnvironmentRoots.length &&
    existingLoader.environmentRoots.every((root, index) => root === resolvedEnvironmentRoots[index])
  ) {
    return existingLoader;
  }

  const loader = createDevelopmentEnvironmentLoader(resolvedAppRoot, resolvedEnvironmentRoots);
  developmentEnvironmentLoaders.set(resolvedAppRoot, loader);
  return loader;
}

function createDevelopmentEnvironmentLoader(
  appRoot: string,
  environmentRoots: readonly string[],
): DevelopmentEnvironmentLoader {
  const protectedValues = new Map(Object.entries(process.env));
  const protectedKeys = new Set(protectedValues.keys());
  const managedValues = new Map<string, string>();

  const stageReload = (): DevelopmentEnvironmentReload => {
    const previousManagedValues = new Map(managedValues);
    const nextValues = readDevelopmentEnvironmentValues(environmentRoots);
    const preferProjectOidc = applyProviderSelection(appRoot, nextValues);
    const affectedKeys = new Set([...managedValues.keys(), ...nextValues.keys()]);
    if (preferProjectOidc) {
      affectedKeys.add("AI_GATEWAY_API_KEY");
      protectedKeys.delete("AI_GATEWAY_API_KEY");
    } else if (protectedValues.has("AI_GATEWAY_API_KEY")) {
      protectedKeys.add("AI_GATEWAY_API_KEY");
      process.env.AI_GATEWAY_API_KEY = protectedValues.get("AI_GATEWAY_API_KEY");
    }
    const previousEnvironment = new Map(
      [...affectedKeys].map((key) => [key, process.env[key]] as const),
    );
    let settled = false;

    if (preferProjectOidc) delete process.env.AI_GATEWAY_API_KEY;
    applyDevelopmentEnvironmentValues({
      managedValues,
      nextValues,
      protectedKeys,
    });

    return {
      commit() {
        settled = true;
      },
      rollback() {
        if (settled) {
          return;
        }
        settled = true;
        managedValues.clear();
        for (const [key, value] of previousManagedValues) {
          managedValues.set(key, value);
        }
        for (const [key, value] of previousEnvironment) {
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
      },
    };
  };

  return {
    environmentRoots,
    reload() {
      stageReload().commit();
    },
    stageReload,
  };
}

function applyProviderSelection(appRoot: string, values: Map<string, string>): boolean {
  if (readProviderSelectionSync(appRoot) !== "ai-gateway-project") return false;
  values.delete("AI_GATEWAY_API_KEY");
  return true;
}

function applyDevelopmentEnvironmentValues(input: {
  readonly managedValues: Map<string, string>;
  readonly nextValues: ReadonlyMap<string, string>;
  readonly protectedKeys: ReadonlySet<string>;
}): void {
  for (const [key, previousValue] of input.managedValues) {
    if (input.nextValues.has(key) || input.protectedKeys.has(key)) {
      continue;
    }

    if (process.env[key] === previousValue) {
      delete process.env[key];
    }

    input.managedValues.delete(key);
  }

  for (const [key, value] of input.nextValues) {
    if (input.protectedKeys.has(key)) {
      continue;
    }

    process.env[key] = value;
    input.managedValues.set(key, value);
  }
}

function readDevelopmentEnvironmentValues(
  environmentRoots: readonly string[],
): Map<string, string> {
  const values = new Map<string, string>();

  for (const environmentRoot of environmentRoots) {
    for (const fileName of [...DEVELOPMENT_ENV_FILE_NAMES].reverse()) {
      try {
        const parsedValues = parseEnv(readFileSync(join(environmentRoot, fileName), "utf8"));

        for (const [key, value] of Object.entries(parsedValues)) {
          if (value !== undefined) values.set(key, value);
        }
      } catch (error) {
        if (!isMissingEnvironmentFileError(error)) throw error;
      }
    }
  }

  return values;
}

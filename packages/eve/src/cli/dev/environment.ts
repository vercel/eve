import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";

import { isObject } from "#shared/guards.js";

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
  const resolvedAppRoot = resolve(appRoot);

  return DEVELOPMENT_ENV_FILE_NAMES.map((fileName) => join(resolvedAppRoot, fileName));
}

/**
 * Loads or reloads local development environment files from the application
 * root.
 *
 * Variables that existed before the first load keep parent-process
 * precedence. Variables supplied by env files are refreshed on subsequent
 * reloads so dev-mode file watching can pick up changed values.
 */
export function loadDevelopmentEnvironmentFiles(appRoot: string): void {
  getDevelopmentEnvironmentLoader(appRoot).reload();
}

export function stageDevelopmentEnvironmentFiles(appRoot: string): DevelopmentEnvironmentReload {
  return getDevelopmentEnvironmentLoader(appRoot).stageReload();
}

export function readDevelopmentEnvironmentHostValues(
  appRoot: string,
): Readonly<Record<string, string | null>> {
  const values: Record<string, string | null> = {};
  const fileValues = readDevelopmentEnvironmentValues(resolve(appRoot));

  for (const key of [...fileValues.keys()].sort((left, right) => left.localeCompare(right))) {
    values[key] = process.env[key] ?? null;
  }

  return values;
}

function getDevelopmentEnvironmentLoader(appRoot: string): DevelopmentEnvironmentLoader {
  const resolvedAppRoot = resolve(appRoot);
  const existingLoader = developmentEnvironmentLoaders.get(resolvedAppRoot);

  if (existingLoader !== undefined) {
    return existingLoader;
  }

  const loader = createDevelopmentEnvironmentLoader(resolvedAppRoot);
  developmentEnvironmentLoaders.set(resolvedAppRoot, loader);
  return loader;
}

function createDevelopmentEnvironmentLoader(appRoot: string): DevelopmentEnvironmentLoader {
  const protectedKeys = new Set(Object.keys(process.env));
  const managedValues = new Map<string, string>();

  const stageReload = (): DevelopmentEnvironmentReload => {
    const previousManagedValues = new Map(managedValues);
    const nextValues = readDevelopmentEnvironmentValues(appRoot);
    const affectedKeys = new Set([...managedValues.keys(), ...nextValues.keys()]);
    const previousEnvironment = new Map(
      [...affectedKeys].map((key) => [key, process.env[key]] as const),
    );
    let settled = false;

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
    reload() {
      stageReload().commit();
    },
    stageReload,
  };
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

function readDevelopmentEnvironmentValues(appRoot: string): Map<string, string> {
  const values = new Map<string, string>();

  for (const fileName of [...DEVELOPMENT_ENV_FILE_NAMES].reverse()) {
    try {
      const parsedValues = parseEnv(readFileSync(join(appRoot, fileName), "utf8"));

      for (const [key, value] of Object.entries(parsedValues)) {
        if (value === undefined) {
          continue;
        }

        values.set(key, value);
      }
    } catch (error) {
      if (!isMissingEnvironmentFileError(error)) {
        throw error;
      }
    }
  }

  return values;
}

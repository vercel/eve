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

  return {
    reload() {
      const nextValues = readDevelopmentEnvironmentValues(appRoot);

      for (const [key, previousValue] of managedValues) {
        if (nextValues.has(key) || protectedKeys.has(key)) {
          continue;
        }

        if (process.env[key] === previousValue) {
          delete process.env[key];
        }

        managedValues.delete(key);
      }

      for (const [key, value] of nextValues) {
        if (protectedKeys.has(key)) {
          continue;
        }

        process.env[key] = value;
        managedValues.set(key, value);
      }
    },
  };
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

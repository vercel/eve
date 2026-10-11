import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

import { isObject } from "#shared/guards.js";

/** Development env files, from highest to lowest precedence. */
export const DEVELOPMENT_ENV_FILE_NAMES = [
  ".env.development.local",
  ".env.local",
  ".env.development",
  ".env",
] as const;

function isMissingEnvironmentFileError(error: unknown): error is NodeJS.ErrnoException {
  return isObject(error) && error.code === "ENOENT";
}

/** Merged values of the development env files in `environmentRoot`, by precedence. */
export function readDevelopmentEnvironmentValues(environmentRoot: string): Map<string, string> {
  const values = new Map<string, string>();

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

  return values;
}

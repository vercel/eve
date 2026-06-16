import { readFile, writeFile } from "node:fs/promises";

export interface AppendEnvOptions {
  /** Replace existing keys. Default: false (existing keys are preserved). */
  force?: boolean;
}

export interface AppendEnvResult {
  /** Keys that were inserted or replaced. */
  written: string[];
  /** Keys that already existed and were preserved (only when `force` is false). */
  skipped: string[];
}

/**
 * Idempotently merges `values` into the `.env`-style file at `envPath`.
 *
 * - Missing keys are appended.
 * - Existing keys are preserved unless `options.force` is true.
 * - The file is created if it does not exist.
 *
 * Returns which keys were written vs. skipped so callers can report
 * accurately ("already had X — kept your value").
 */
export async function appendEnv(
  envPath: string,
  values: Record<string, string>,
  options: AppendEnvOptions = {},
): Promise<AppendEnvResult> {
  let existing = "";
  try {
    existing = await readFile(envPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const lines = existing.split("\n");
  const written: string[] = [];
  const skipped: string[] = [];

  for (const [key, value] of Object.entries(values)) {
    const matchIndex = lines.findIndex((line) => line.startsWith(`${key}=`));
    if (matchIndex >= 0) {
      if (options.force) {
        lines[matchIndex] = `${key}=${value}`;
        written.push(key);
      } else {
        skipped.push(key);
      }
    } else {
      lines.push(`${key}=${value}`);
      written.push(key);
    }
  }

  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  await writeFile(envPath, `${lines.join("\n")}\n`, "utf8");

  return { written, skipped };
}

import { access, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

import { loadAuthoredModuleNamespace } from "#internal/authored-module-loader.js";
import type { EveEval, EveEvalConfig, EveEvalDefinition } from "#evals/types.js";

const EVAL_FILE_SUFFIX = ".eval.ts";

/** Required run-wide config file at the root of the `evals/` directory. */
const EVAL_CONFIG_FILE = "evals.config.ts";

/** Width of the zero-padded index suffix for array-exported evals. */
const ARRAY_INDEX_PAD = 4;

/**
 * Discovers eval files under `<appRoot>/evals/` by recursively
 * scanning for files matching `*.eval.ts`.
 *
 * Returns absolute paths sorted alphabetically by relative path.
 */
export async function discoverEvalFiles(appRoot: string): Promise<string[]> {
  const evalsDir = join(appRoot, "evals");
  const files: string[] = [];

  try {
    await collectEvalFiles(evalsDir, files);
  } catch (error) {
    if (isNoEntryError(error)) {
      return [];
    }
    throw error;
  }

  files.sort((a, b) => relative(evalsDir, a).localeCompare(relative(evalsDir, b)));
  return files;
}

/**
 * Finds directories under `<appRoot>/agent/` that directly contain
 * `*.eval.ts` files. Used to produce a clear error when eval files are placed
 * inside the agent tree instead of the top-level `evals/` directory that
 * {@link discoverEvalFiles} scans.
 *
 * Returns app-root-relative, POSIX-normalized directory paths, sorted and
 * de-duplicated. Returns `[]` when `agent/` is absent.
 */
export async function findMisplacedEvalDirs(appRoot: string): Promise<string[]> {
  const agentDir = join(appRoot, "agent");
  const dirs = new Set<string>();

  try {
    await collectMisplacedEvalDirs(agentDir, appRoot, dirs);
  } catch (error) {
    if (isNoEntryError(error)) {
      return [];
    }
    throw error;
  }

  return [...dirs].sort((a, b) => a.localeCompare(b));
}

/**
 * Derives the canonical eval id from one absolute eval file path.
 *
 * `<appRoot>/evals/sub/weather.eval.ts` → `"sub/weather"`.
 */
function deriveEvalId(appRoot: string, filePath: string): string {
  const evalsDir = join(appRoot, "evals");
  const relativePath = relative(evalsDir, filePath).split(/[\\/]/u).join("/");

  if (relativePath.endsWith(EVAL_FILE_SUFFIX)) {
    return relativePath.slice(0, -EVAL_FILE_SUFFIX.length);
  }

  return relativePath;
}

/**
 * Returns true when `evalId` matches one of the requested filters. A filter
 * matches its exact eval id or any eval nested under it, so `"runtime"`
 * matches both `evals/runtime.eval.ts` and every eval in `evals/runtime/`
 * (and every entry of an array-exported `evals/runtime.eval.ts`).
 */
export function matchesEvalFilter(evalId: string, filters: readonly string[]): boolean {
  if (filters.length === 0) return true;
  return filters.some((filter) => evalId === filter || evalId.startsWith(`${filter}/`));
}

/**
 * Imports a discovered eval file and stamps the path-derived id(s) onto
 * the eval definition(s).
 *
 * The file must `export default` either one `EveEvalDefinition` (produced
 * by `defineEval()`) or an array of them. A single definition derives its
 * id from the file path; array entries derive `<file-id>/<index>` ids with
 * the index zero-padded to four digits (e.g. `"weather/0000"`).
 */
export async function importEvalFile(appRoot: string, filePath: string): Promise<EveEval[]> {
  const module = (await loadAuthoredModuleNamespace(filePath)) as Record<string, unknown>;
  const exported = module.default;
  const fileId = deriveEvalId(appRoot, filePath);

  if (isEveEvalDefinition(exported)) {
    return [{ ...exported, id: fileId }];
  }

  if (Array.isArray(exported)) {
    return exported.map((definition, index) => {
      if (!isEveEvalDefinition(definition)) {
        throw new Error(
          `Eval file "${filePath}" exports an array whose entry at index ${index} is not ` +
            `a valid EveEval. Use defineEval() to create every entry.`,
        );
      }
      return { ...definition, id: `${fileId}/${String(index).padStart(ARRAY_INDEX_PAD, "0")}` };
    });
  }

  throw new Error(
    `Eval file "${filePath}" does not export a valid EveEval (or array of EveEvals) as its ` +
      `default export. Use defineEval() to create the eval.`,
  );
}

/**
 * Discovers and imports all eval files, optionally filtering by eval id.
 * Filters match exactly or by directory prefix (see {@link matchesEvalFilter}).
 *
 * Throws when two files derive the same eval id (e.g. an array-exported
 * `evals/weather.eval.ts` colliding with `evals/weather/0000.eval.ts`).
 */
export async function discoverAndImportEvals(
  appRoot: string,
  evalIds?: readonly string[],
): Promise<EveEval[]> {
  const files = await discoverEvalFiles(appRoot);

  if (files.length === 0) {
    return [];
  }

  const filters = evalIds ?? [];
  const evaluations: EveEval[] = [];
  const sources = new Map<string, string>();

  for (const file of files) {
    for (const evaluation of await importEvalFile(appRoot, file)) {
      const existing = sources.get(evaluation.id);
      if (existing !== undefined) {
        throw new Error(
          `Duplicate eval id "${evaluation.id}" derived from both "${existing}" and "${file}".`,
        );
      }
      sources.set(evaluation.id, file);

      if (matchesEvalFilter(evaluation.id, filters)) {
        evaluations.push(evaluation);
      }
    }
  }

  return evaluations;
}

/**
 * Discovers and imports the required `evals/evals.config.ts` run-wide
 * configuration (produced by `defineEvalConfig()`).
 *
 * Throws when the file is missing or does not default-export a valid
 * `EveEvalConfig`.
 */
export async function discoverEvalConfig(appRoot: string): Promise<EveEvalConfig> {
  const configPath = join(appRoot, "evals", EVAL_CONFIG_FILE);

  try {
    await access(configPath);
  } catch (error) {
    if (isNoEntryError(error)) {
      throw new Error(
        `Missing required eval config at evals/${EVAL_CONFIG_FILE}. Create it with ` +
          "defineEvalConfig({}) (optionally `{ judge: { model } }` to set the default judge " +
          "model for `t.judge.*` assertions).",
      );
    }
    throw error;
  }

  const module = (await loadAuthoredModuleNamespace(configPath)) as Record<string, unknown>;
  const exported = module.default;

  if (!isEveEvalConfig(exported)) {
    throw new Error(
      `Eval config "evals/${EVAL_CONFIG_FILE}" must default-export a defineEvalConfig() value.`,
    );
  }

  return exported;
}

function isEveEvalConfig(value: unknown): value is EveEvalConfig {
  return (
    typeof value === "object" &&
    value !== null &&
    "_tag" in value &&
    (value as { _tag: unknown })._tag === "EveEvalConfig"
  );
}

function isEveEvalDefinition(value: unknown): value is EveEvalDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    "_tag" in value &&
    (value as { _tag: unknown })._tag === "EveEval"
  );
}

async function collectEvalFiles(dir: string, files: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      await collectEvalFiles(entryPath, files);
    } else if (entry.isFile() && entry.name.endsWith(EVAL_FILE_SUFFIX)) {
      files.push(entryPath);
    }
  }
}

async function collectMisplacedEvalDirs(
  dir: string,
  appRoot: string,
  dirs: Set<string>,
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      await collectMisplacedEvalDirs(join(dir, entry.name), appRoot, dirs);
    } else if (entry.isFile() && entry.name.endsWith(EVAL_FILE_SUFFIX)) {
      dirs.add(relative(appRoot, dir).split(/[\\/]/u).join("/"));
    }
  }
}

function isNoEntryError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: string }).code === "ENOENT"
  );
}

/**
 * Discovers and loads the tool stub sets in `evals/stubs/`.
 *
 * Only the local server `eve eval` starts imports this module, by file path,
 * so hosted bundles never include it or the authored-module bundler it uses.
 */

import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

import { isToolStubs, type ToolStubs } from "#evals/tool-stubs.js";
import { loadAuthoredModuleNamespace } from "#internal/authored-module-loader.js";

const STUB_SET_FILE_SUFFIX = ".ts";
const EXCLUDED_FILE_SUFFIXES = [".d.ts", ".eval.ts"] as const;

const loadedSets = new Map<string, Promise<ToolStubs>>();

/** Lists set names in `directory`: file paths relative to it, without `.ts`, sorted. */
export async function listToolStubSets(directory: string): Promise<string[]> {
  const files: string[] = [];
  try {
    await collectStubSetFiles(directory, files);
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return [];
    throw error;
  }
  return files
    .map((file) =>
      relative(directory, file).split(/[\\/]/u).join("/").slice(0, -STUB_SET_FILE_SUFFIX.length),
    )
    .sort((left, right) => left.localeCompare(right));
}

/** Imports one set by name. Each set loads once per process. */
export function loadToolStubSet(directory: string, name: string): Promise<ToolStubs> {
  const filePath = join(directory, `${name}${STUB_SET_FILE_SUFFIX}`);
  let loaded = loadedSets.get(filePath);
  if (loaded === undefined) {
    loaded = importToolStubSet(filePath, name);
    loadedSets.set(filePath, loaded);
    loaded.catch(() => loadedSets.delete(filePath));
  }
  return loaded;
}

async function importToolStubSet(filePath: string, name: string): Promise<ToolStubs> {
  const exported = (await loadAuthoredModuleNamespace(filePath)).default;
  if (!isToolStubs(exported)) {
    throw new Error(
      `Tool stub set "${name}" (evals/stubs/${name}.ts) must default-export defineToolStubs({ ... }) from "eve/evals".`,
    );
  }
  return exported;
}

async function collectStubSetFiles(directory: string, files: string[]): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectStubSetFiles(entryPath, files);
    } else if (
      entry.isFile() &&
      entry.name.endsWith(STUB_SET_FILE_SUFFIX) &&
      !EXCLUDED_FILE_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))
    ) {
      files.push(entryPath);
    }
  }
}

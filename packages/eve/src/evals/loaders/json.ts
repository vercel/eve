import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

/**
 * Loads and parses a JSON file, returning the parsed value.
 *
 * Paths resolve relative to the application root directory (current working
 * directory). Pass an absolute path to load it directly.
 *
 * @example
 * ```ts
 * const data = await loadJson("evals/data/cases.json");
 * ```
 */
export async function loadJson(filePath: string): Promise<unknown> {
  const resolved = isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath);
  const raw = await readFile(resolved, "utf-8");
  return JSON.parse(raw) as unknown;
}

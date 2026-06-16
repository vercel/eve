import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import matter from "#compiled/gray-matter/index.js";

/**
 * Loads a YAML file and returns its top-level mapping as a plain object.
 *
 * Paths resolve relative to the application root directory (current working
 * directory). An absolute path loads directly. It parses the file as a YAML
 * mapping, so the result is always a `Record<string, unknown>` (never a scalar
 * or array). If the file begins with a `---` frontmatter delimiter, it returns
 * only the frontmatter mapping and ignores any content after the closing `---`.
 *
 * @example
 * ```ts
 * const doc = await loadYaml("evals/data/cases.yaml");
 * const rows = doc.evals;
 * ```
 */
export async function loadYaml(filePath: string): Promise<Record<string, unknown>> {
  const resolved = isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath);
  const raw = await readFile(resolved, "utf-8");

  // gray-matter parses YAML frontmatter from content. For pure YAML files
  // we wrap the content so gray-matter sees the entire file as frontmatter.
  const needsWrapper = !raw.trimStart().startsWith("---");
  const input = needsWrapper ? `---\n${raw}\n---` : raw;
  const parsed = matter(input);

  return (parsed.data ?? {}) as Record<string, unknown>;
}

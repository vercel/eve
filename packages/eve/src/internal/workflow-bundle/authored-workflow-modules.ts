import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { prepareAuthoredWorkflowDirectives } from "./authored-workflow-directives.js";
import { isAuthoredApplicationModule, isAuthoredApplicationRoot } from "./workflow-builders.js";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

// Build output, caches, and dependency trees never hold authored agent source.
const IGNORED_DIRECTORIES = new Set([
  ".cache",
  ".eve",
  ".git",
  ".next",
  ".nuxt",
  ".output",
  ".pnpm-store",
  ".svelte-kit",
  ".turbo",
  ".vercel",
  ".yarn",
  "coverage",
  "dist",
  "node_modules",
]);

/** Authored application modules that declare Workflow directives. */
export interface AuthoredWorkflowModules {
  /** Every module with a `"use step"` or `"use workflow"` function; the server registers their steps. */
  readonly directiveModules: readonly string[];
  /** Modules with a `"use workflow"` function; the workflow driver bundle imports these. */
  readonly workflowModules: readonly string[];
}

/**
 * Finds the application modules whose functions carry Workflow directives.
 *
 * Scans every source file under the application root, the same scope the
 * Workflow SDK's own bundler integrations transform, so a step helper can
 * live wherever the tool that calls it imports it from. Each textual hit is
 * confirmed and validated by the directive pre-pass, which turns an invalid
 * placement into a build error here rather than a silent no-op at run time.
 */
export async function discoverAuthoredWorkflowModules(
  appRoot: string,
): Promise<AuthoredWorkflowModules> {
  const directiveModules: string[] = [];
  const workflowModules: string[] = [];
  if (!isAuthoredApplicationRoot(appRoot)) return { directiveModules, workflowModules };

  const files = await collectSourceFiles(appRoot);
  for (const filePath of files.sort()) {
    if (!isAuthoredApplicationModule(filePath, appRoot)) continue;
    const prepared = await prepareAuthoredWorkflowDirectives({
      filePath,
      source: await readFile(filePath, "utf8"),
    });
    if (!prepared.hasDirectives) continue;
    directiveModules.push(filePath);
    if (prepared.hasWorkflowDirective) workflowModules.push(filePath);
  }

  return { directiveModules, workflowModules };
}

async function collectSourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];

  async function visit(directory: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }

    for (const entry of entries) {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) await visit(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = entry.name.match(/\.[^.]+$/)?.[0];
      if (extension !== undefined && SOURCE_EXTENSIONS.has(extension)) files.push(entryPath);
    }
  }

  await visit(root);
  return files;
}

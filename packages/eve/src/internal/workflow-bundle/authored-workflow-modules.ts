import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { prepareAuthoredWorkflowDirectives } from "./authored-workflow-directives.js";
import { isAuthoredApplicationModule, isAuthoredApplicationRoot } from "./workflow-builders.js";

// Only modules that mention a directive reach the parser: an app root holds
// arbitrary source (React components, scripts) the pre-pass must never fail on.
const DIRECTIVE_TEXT = /["'](?:use workflow|use step)["']/;

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

// Dependency trees, build output, and every hidden directory (`.eve`, `.next`,
// `.output.eve-backup-*`, …) hold generated code, never authored agent source.
// eve's own bundles carry `"use step"` strings that are not authored directives.
const IGNORED_DIRECTORIES = new Set(["coverage", "dist", "node_modules"]);

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
    const source = await readFile(filePath, "utf8");
    if (!DIRECTIVE_TEXT.test(source)) continue;
    const prepared = await prepareAuthoredWorkflowDirectives({ filePath, source });
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
        if (!entry.name.startsWith(".") && !IGNORED_DIRECTORIES.has(entry.name)) {
          await visit(entryPath);
        }
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

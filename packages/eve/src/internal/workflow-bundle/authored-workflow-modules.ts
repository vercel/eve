import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  detectWorkflowPatterns,
  isGeneratedWorkflowFile,
} from "#compiled/@workflow/builders/index.js";

import { prepareAuthoredWorkflowDirectives } from "./authored-workflow-directives.js";
import { isWorkflowSourceFile } from "./builder-support.js";
import { isAuthoredApplicationModule, isAuthoredApplicationRoot } from "./workflow-builders.js";

// The Workflow SDK's own discovery ignore list (`BaseBuilder.getInputFiles` in
// @workflow/builders), plus eve's generated locations: `.eve`, `dist`, and the
// `.output.eve-backup-*` directories a publication leaves while it recovers.
const IGNORED_DIRECTORIES = new Set([
  ".cache",
  ".eve",
  ".git",
  ".next",
  ".nitro",
  ".nuxt",
  ".output",
  ".pnpm-store",
  ".svelte-kit",
  ".swc",
  ".turbo",
  ".vercel",
  ".workflow-data",
  ".workflow-vitest",
  ".yarn",
  "coverage",
  "dist",
  "node_modules",
]);

function isIgnoredDirectory(name: string): boolean {
  return IGNORED_DIRECTORIES.has(name) || name.startsWith(".output.");
}

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
 * live wherever the tool that calls it imports it from. The SDK's own regexp
 * pre-scan picks the few files worth parsing; the directive pre-pass then
 * confirms each on the AST and turns an invalid placement into a build error
 * here rather than a silent no-op at run time.
 */
export async function discoverAuthoredWorkflowModules(
  appRoot: string,
): Promise<AuthoredWorkflowModules> {
  const directiveModules: string[] = [];
  const workflowModules: string[] = [];
  if (!isAuthoredApplicationRoot(appRoot)) return { directiveModules, workflowModules };

  const files = await collectSourceFiles(appRoot);
  for (const filePath of files.sort()) {
    if (!isAuthoredApplicationModule(filePath, appRoot) || isGeneratedWorkflowFile(filePath))
      continue;
    const source = await readFile(filePath, "utf8");
    if (!detectWorkflowPatterns(source).hasDirective) continue;
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
        if (!isIgnoredDirectory(entry.name)) await visit(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isWorkflowSourceFile(entry.name)) files.push(entryPath);
    }
  }

  await visit(root);
  return files;
}

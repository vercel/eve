import { createRequire } from "node:module";
import { dirname } from "node:path";

import type { BuildOptions, OutputAsset, OutputChunk, RolldownOutput } from "rolldown";

import { createPseudoPackagePlugin } from "#internal/bundler/pseudo-packages.js";
import {
  type BundlerDefaultLogHandler,
  onVendoredDependencyLog,
} from "#internal/bundler/vendored-dependency-log.js";

export type RolldownOutputChunk = OutputChunk;
export type RolldownOutputAsset = OutputAsset;

/**
 * Build options as eve's callers assemble them. Plugins stay loosely typed:
 * eve's plugin factories return plain hook objects, which Rolldown validates.
 */
export type RolldownBuildInput = Record<string, unknown> & {
  readonly experimental?: Record<string, unknown>;
  readonly plugins?: readonly unknown[];
};

type RolldownParserLanguage = "js" | "jsx" | "ts" | "tsx";

let rolldownPromise: Promise<typeof import("rolldown")> | undefined;
let rolldownParseAstPromise: Promise<typeof import("rolldown/parseAst")> | undefined;

/**
 * Loads eve's own Rolldown, the copy Nitro also builds with through
 * `deps.paths`. Lazy, so commands that never bundle skip the native binding.
 */
function loadRolldown(): Promise<typeof import("rolldown")> {
  rolldownPromise ??= import("rolldown");
  return rolldownPromise;
}

/** eve's Rolldown package directory, which Nitro builds with through `deps.paths`. */
export function resolveRolldownPackageDir(): string {
  return dirname(createRequire(import.meta.url).resolve("rolldown/package.json"));
}

function loadRolldownParseAst(): Promise<typeof import("rolldown/parseAst")> {
  rolldownParseAstPromise ??= import("rolldown/parseAst");
  return rolldownParseAstPromise;
}

function inferRolldownParserLanguage(filename: string): RolldownParserLanguage {
  if (filename.endsWith(".tsx")) return "tsx";
  if (filename.endsWith(".jsx")) return "jsx";
  if (/\.[cm]?ts$/.test(filename)) return "ts";
  return "js";
}

export async function parseWithRolldownAst(filename: string, sourceText: string): Promise<unknown> {
  const { parseAst } = await loadRolldownParseAst();
  return parseAst(
    sourceText,
    {
      astType: "ts",
      lang: inferRolldownParserLanguage(filename),
      range: true,
      sourceType: "module",
    },
    filename,
  );
}

/**
 * Runs a raw Rolldown build. Prefer {@link buildSingleRolldownChunk} for any
 * bundle whose consumer expects one in-memory file; use this directly only
 * for multi-file, written-to-disk output. Warnings raised only by dependency
 * code are dropped unless the caller supplies its own `onLog`, except
 * unresolved imports. Pseudo-packages such as `server-only` load as empty
 * modules ahead of every caller plugin.
 */
export async function buildWithRolldown(options: RolldownBuildInput): Promise<RolldownOutput> {
  assertCustomRolldownConditionNames(options);
  const { build } = await loadRolldown();
  return await build({
    // eve's own plugins dominate the timings, which the app cannot act on.
    checks: { bundlerTimings: false },
    onLog: onRolldownBuildLog,
    ...options,
    plugins: [createPseudoPackagePlugin(), ...(options.plugins ?? [])],
    // Debug module IDs contain temporary workspace paths and destabilize runtime fingerprints.
    experimental: { ...options.experimental, attachDebugInfo: "none" },
  } as BuildOptions);
}

// Unlike the Nitro host build, whose dependency graph deliberately leaves
// optional imports such as `just-bash` unresolved, these bundles inline their
// dependencies, so an unresolved import there only fails once the bundle loads.
function onRolldownBuildLog(
  level: string,
  log: unknown,
  defaultHandler: BundlerDefaultLogHandler,
): void {
  if (level === "warn" && (log as { code?: unknown } | null)?.code === "UNRESOLVED_IMPORT") {
    defaultHandler(level, log);
    return;
  }
  onVendoredDependencyLog(level, log, defaultHandler);
}

export const ROLLDOWN_STANDARD_CONDITION_NAMES: ReadonlySet<string> = new Set([
  "browser",
  "default",
  "import",
  "node",
  "require",
]);

function assertCustomRolldownConditionNames(options: RolldownBuildInput): void {
  const resolve = options.resolve;
  if (resolve === null || typeof resolve !== "object") return;
  const conditionNames = Reflect.get(resolve, "conditionNames");
  if (!Array.isArray(conditionNames)) return;

  for (const conditionName of conditionNames) {
    if (typeof conditionName === "string" && ROLLDOWN_STANDARD_CONDITION_NAMES.has(conditionName)) {
      throw new Error(
        `Rolldown resolves the standard condition ${JSON.stringify(conditionName)} per import edge; conditionNames may contain only eve-specific additions.`,
      );
    }
  }
}

/**
 * Runs a Rolldown build whose contract is exactly one in-memory chunk:
 * code splitting is disabled and the result is asserted to contain a
 * single JavaScript chunk, so dynamic imports are inlined rather than
 * split into lazy chunks. Every eve single-file bundle (the authored-module
 * evaluator, immutable development generations, and workflow step/function
 * bundles) goes through this helper so the single-file policy and its
 * assertion cannot drift apart. The final Nitro production server build
 * does not use it and keeps code splitting enabled.
 */
export async function buildSingleRolldownChunk(
  description: string,
  options: RolldownBuildInput & { readonly output?: Record<string, unknown> },
): Promise<RolldownOutputChunk> {
  const result = await buildWithRolldown({
    ...options,
    write: false,
    output: { ...options.output, codeSplitting: false },
  });
  return getSingleRolldownChunk(result, description);
}

function getSingleRolldownChunk(output: RolldownOutput, description: string): RolldownOutputChunk {
  const chunks = output.output.filter((item) => item.type === "chunk");
  const chunk = chunks[0];

  if (chunk === undefined || chunks.length !== 1) {
    throw new Error(`Expected one bundled ${description}.`);
  }

  return chunk;
}

import { createRequire } from "node:module";
import { dirname } from "node:path";

import type {
  BuildOptions,
  LogLevel,
  LogOrStringHandler,
  OutputAsset,
  OutputChunk,
  RolldownLog,
  RolldownOutput,
} from "rolldown";

import { noteBundledModules } from "#internal/bundler/bundled-module-recorder.js";
import { createPseudoPackagePlugin } from "#internal/bundler/pseudo-packages.js";
import { onVendoredDependencyLog } from "#internal/bundler/vendored-dependency-log.js";

export type RolldownOutputChunk = OutputChunk;
export type RolldownOutputAsset = OutputAsset;

type RolldownParserLanguage = "js" | "jsx" | "ts" | "tsx";

let rolldownPromise: Promise<typeof import("rolldown")> | undefined;
let rolldownParseAstPromise: Promise<typeof import("rolldown/parseAst")> | undefined;

function loadRolldown(): Promise<typeof import("rolldown")> {
  rolldownPromise ??= import("rolldown");
  return rolldownPromise;
}

export function resolveRolldownPackageDir(): string {
  return dirname(createRequire(import.meta.url).resolve("rolldown/package.json"));
}

function loadRolldownParseAst(): Promise<typeof import("rolldown/parseAst")> {
  rolldownParseAstPromise ??= import("rolldown/parseAst");
  return rolldownParseAstPromise;
}

export function inferRolldownParserLanguage(filename: string): RolldownParserLanguage {
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

export async function buildWithRolldown(options: BuildOptions): Promise<RolldownOutput> {
  assertCustomRolldownConditionNames(options);
  const { build } = await loadRolldown();
  const output = await build({
    checks: { bundlerTimings: false },
    onLog: onRolldownBuildLog,
    ...options,
    plugins: [createPseudoPackagePlugin(), options.plugins],
    experimental: { ...options.experimental, attachDebugInfo: "none" },
  });
  noteBundledModules(() =>
    output.output.flatMap((item) => (item.type === "chunk" ? item.moduleIds : [])),
  );
  return output;
}

function onRolldownBuildLog(
  level: LogLevel,
  log: RolldownLog,
  defaultHandler: LogOrStringHandler,
): void {
  if (level === "warn" && log.code === "UNRESOLVED_IMPORT") {
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

function assertCustomRolldownConditionNames(options: BuildOptions): void {
  for (const conditionName of options.resolve?.conditionNames ?? []) {
    if (ROLLDOWN_STANDARD_CONDITION_NAMES.has(conditionName)) {
      throw new Error(
        `Rolldown resolves the standard condition ${JSON.stringify(conditionName)} per import edge; conditionNames may contain only eve-specific additions.`,
      );
    }
  }
}

export async function buildSingleRolldownChunk(
  description: string,
  options: BuildOptions,
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

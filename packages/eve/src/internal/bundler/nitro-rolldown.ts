import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

type RolldownOutputChunk = {
  readonly type: "chunk";
  readonly code: string;
  readonly fileName: string;
};

type RolldownOutputAsset = {
  readonly type: "asset";
  readonly fileName: string;
  readonly source: string | Uint8Array;
};

type RolldownOutput = {
  readonly output: readonly [RolldownOutputChunk, ...(RolldownOutputChunk | RolldownOutputAsset)[]];
};

type RolldownBuild = (options: Record<string, unknown>) => Promise<RolldownOutput>;
type RolldownParseAst = (
  sourceText: string,
  options?: Record<string, unknown> | null,
  filename?: string,
) => unknown;
export type RolldownParserLanguage = "js" | "jsx" | "ts" | "tsx";

type RolldownModule = {
  readonly build: RolldownBuild;
};

type RolldownParseAstModule = {
  readonly parseAst: RolldownParseAst;
};

let rolldownPromise: Promise<RolldownModule> | undefined;
let rolldownParseAstPromise: Promise<RolldownParseAstModule> | undefined;

/**
 * Loads Rolldown from Nitro's dependency tree so eve does not carry a second
 * native bundler package in its own install footprint.
 */
function loadNitroRolldown(): Promise<RolldownModule> {
  rolldownPromise ??= (async () => {
    const require = createRequire(import.meta.url);
    const nitroRequire = createRequire(require.resolve("nitro/package.json"));
    const rolldownPath = nitroRequire.resolve("rolldown");
    return (await import(pathToFileURL(rolldownPath).href)) as RolldownModule;
  })();

  return rolldownPromise;
}

/**
 * Loads Rolldown's parser from Nitro's dependency tree so workflow directive
 * transforms can use the same bundler dependency without exposing it publicly.
 */
export function loadNitroRolldownParseAst(): Promise<RolldownParseAstModule> {
  rolldownParseAstPromise ??= (async () => {
    const require = createRequire(import.meta.url);
    const nitroRequire = createRequire(require.resolve("nitro/package.json"));
    const parseAstPath = nitroRequire.resolve("rolldown/parseAst");
    return (await import(pathToFileURL(parseAstPath).href)) as RolldownParseAstModule;
  })();

  return rolldownParseAstPromise;
}

export function inferRolldownParserLanguage(filename: string): RolldownParserLanguage {
  if (filename.endsWith(".tsx")) return "tsx";
  if (filename.endsWith(".jsx")) return "jsx";
  if (/\.[cm]?ts$/.test(filename)) return "ts";
  return "js";
}

export async function parseWithNitroRolldownAst(
  filename: string,
  sourceText: string,
): Promise<unknown> {
  const { parseAst } = await loadNitroRolldownParseAst();
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
 * for multi-file, written-to-disk output.
 */
export async function buildWithNitroRolldown(
  options: Record<string, unknown>,
): Promise<RolldownOutput> {
  const { build } = await loadNitroRolldown();
  return await build(options);
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
  options: Record<string, unknown> & { readonly output?: Record<string, unknown> },
): Promise<RolldownOutputChunk> {
  const result = await buildWithNitroRolldown({
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

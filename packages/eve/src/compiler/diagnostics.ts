import { z } from "#compiled/zod/index.js";

import type { DiscoverDiagnostic, DiscoverDiagnosticsSummary } from "#discover/diagnostics.js";
import type { AgentSourceDescriptor } from "#compiler/source-graph.js";

const compilerDiagnosticSeveritySchema = z.enum(["error", "warning"]);

const compilerDiagnosticSourceSchema = z
  .object({
    logicalPath: z.string().optional(),
    nodeId: z.string().min(1),
    sourceId: z.string().optional(),
    sourcePath: z.string().optional(),
  })
  .strict()
  .refine(
    (source) =>
      source.logicalPath !== undefined ||
      source.sourceId !== undefined ||
      source.sourcePath !== undefined,
    "Compiler diagnostic source must identify a logical, compiled, or physical source.",
  );

type CompilerDiagnosticSource = z.infer<typeof compilerDiagnosticSourceSchema>;

export const compilerDiagnosticSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    severity: compilerDiagnosticSeveritySchema,
    sources: z.array(compilerDiagnosticSourceSchema).min(1).readonly(),
  })
  .strict();

export type CompilerDiagnostic = z.infer<typeof compilerDiagnosticSchema>;

export function projectDiscoverDiagnostic(
  diagnostic: DiscoverDiagnostic,
  nodeId: string,
): CompilerDiagnostic {
  return {
    code: diagnostic.code,
    message: diagnostic.message,
    severity: diagnostic.severity,
    sources: [{ nodeId, sourcePath: diagnostic.sourcePath }],
  };
}

export function createChannelRouteShadowedDiagnostic(input: {
  readonly loser: AgentSourceDescriptor;
  readonly method: string;
  readonly nodeId: string;
  readonly urlPath: string;
  readonly winner: AgentSourceDescriptor;
}): CompilerDiagnostic {
  return {
    code: "compile/channel-route-shadowed",
    message:
      `${input.method} ${input.urlPath} from "${input.loser.logicalPath}" is shadowed by ` +
      `"${input.winner.logicalPath}".`,
    severity: "warning",
    sources: [
      toDiagnosticSource(input.nodeId, input.loser),
      toDiagnosticSource(input.nodeId, input.winner),
    ],
  };
}

export const COMPILE_TOOL_INPUT_SCHEMA_INVALID = "compile/tool-input-schema-invalid";

export function createToolInputSchemaInvalidDiagnostic(input: {
  readonly nodeId: string;
  readonly problem: string;
  readonly source: AgentSourceDescriptor;
}): CompilerDiagnostic {
  return {
    code: COMPILE_TOOL_INPUT_SCHEMA_INVALID,
    message: `Tool "${input.source.logicalPath}" has an invalid inputSchema: ${input.problem}, so eve can't validate the tool's input.`,
    severity: "error",
    sources: [toDiagnosticSource(input.nodeId, input.source)],
  };
}

export function summarizeCompilerDiagnostics(
  diagnostics: readonly CompilerDiagnostic[],
): DiscoverDiagnosticsSummary {
  let errors = 0;
  let warnings = 0;
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === "error") errors += 1;
    else warnings += 1;
  }
  return { errors, warnings };
}

export function formatDiagnosticSources(diagnostic: CompilerDiagnostic): string {
  return diagnostic.sources
    .map((source) => source.sourcePath ?? source.logicalPath ?? source.sourceId ?? source.nodeId)
    .join(", ");
}

function toDiagnosticSource(
  nodeId: string,
  source: AgentSourceDescriptor,
): CompilerDiagnosticSource {
  return {
    logicalPath: source.logicalPath,
    nodeId,
    sourceId: source.sourceId,
    ...(source.backing.kind === "filesystem" || source.backing.kind === "resource"
      ? { sourcePath: source.backing.sourcePath }
      : {}),
  };
}

import { z } from "#compiled/zod/index.js";

import type { DiscoverDiagnostic, DiscoverDiagnosticsSummary } from "#discover/diagnostics.js";
import type { AgentSourceDescriptor } from "#compiler/source-graph.js";

export const compilerDiagnosticSeveritySchema = z.enum(["error", "warning"]);

export const compilerDiagnosticSourceSchema = z
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

export type CompilerDiagnosticSource = z.infer<typeof compilerDiagnosticSourceSchema>;

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

export function createLegacySubagentDefinitionDiagnostic(input: {
  readonly logicalPath: string;
  readonly nodeId: string;
  readonly sourceId: string;
}): CompilerDiagnostic {
  return {
    code: "compile/subagent-legacy-definition",
    message: `Subagent "${input.logicalPath}" uses a legacy agent helper. Replace it with defineLocalSubagent(...) or defineRemoteSubagent(...) and choose background explicitly.`,
    severity: "warning",
    sources: [{ logicalPath: input.logicalPath, nodeId: input.nodeId, sourceId: input.sourceId }],
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

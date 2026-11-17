import { z } from "#compiled/zod/index.js";

import type { DiscoverDiagnostic, DiscoverDiagnosticsSummary } from "#discover/diagnostics.js";
import type { CompiledToolDefinition } from "#compiler/manifest.js";
import type { AgentModuleBinding, AgentSourceDescriptor } from "#compiler/source-graph.js";
import { EXECUTE_TOOL_NAME } from "#protocol/catalog-tools.js";

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

/**
 * For an agent with code mode on: one warning for each of `tools` the application authors.
 * `tools` are those a program can call and reads as `unknown`, for want of an output schema.
 */
export function createCodeModeUntypedToolDiagnostics(input: {
  readonly bindings: Readonly<Record<string, AgentModuleBinding>>;
  readonly nodeId: string;
  readonly tools: readonly CompiledToolDefinition[];
}): CompilerDiagnostic[] {
  return input.tools.flatMap((tool) => {
    const binding = input.bindings[tool.sourceId];
    // An extension's tools are its author's to type, not the application's.
    if (binding?.owner.kind !== "application") {
      return [];
    }
    return [
      {
        code: "compile/code-mode-untyped-tool",
        message: `Tool "${tool.name}" has no outputSchema, so programs run by ${EXECUTE_TOOL_NAME} read its result as unknown. Add an outputSchema to type it.`,
        severity: "warning",
        sources: [
          toDiagnosticSource(input.nodeId, {
            backing: binding.backing,
            logicalPath: tool.logicalPath,
            sourceId: tool.sourceId,
          }),
        ],
      },
    ];
  });
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
  source: Pick<AgentSourceDescriptor, "backing" | "logicalPath" | "sourceId">,
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

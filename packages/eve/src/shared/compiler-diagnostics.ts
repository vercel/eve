import { z } from "#compiled/zod/index.js";

const nonBlankStringSchema = z
  .string()
  .refine((value) => value.trim().length > 0, "Expected a non-empty string.");

/** Stable diagnostic code for an ordinary channel route loser. */
export const CHANNEL_ROUTE_SHADOWED_DIAGNOSTIC_CODE = "compile/channel-route-shadowed";

/**
 * Structured compiler diagnostic severity.
 */
export type CompilerDiagnosticSeverity = z.infer<typeof compilerDiagnosticSeveritySchema>;

/**
 * Zod schema for structured compiler diagnostic severities.
 */
export const compilerDiagnosticSeveritySchema = z.union([z.literal("error"), z.literal("warning")]);

/**
 * Structured compiler diagnostic emitted while discovering, normalizing, or
 * planning authored sources.
 */
export type CompilerDiagnostic = z.infer<typeof compilerDiagnosticSchema>;

/**
 * Zod schema for one structured compiler diagnostic.
 */
export const compilerDiagnosticSchema = z
  .object({
    /**
     * Stable machine-readable diagnostic code.
     */
    code: nonBlankStringSchema,
    /**
     * Human-readable diagnostic message.
     */
    message: nonBlankStringSchema,
    /**
     * Discovery severity.
     */
    severity: compilerDiagnosticSeveritySchema,
    /** Compiled agent node that owns this source locator. */
    nodeId: nonBlankStringSchema,
    /** Logical source path associated with the diagnostic, when known. */
    logicalPath: nonBlankStringSchema.optional(),
    /** Stable source identity associated with the diagnostic, when known. */
    sourceId: nonBlankStringSchema.optional(),
    /** Physical source path, when the source is disk-backed. */
    sourcePath: nonBlankStringSchema.optional(),
    /** Structured route identity for diagnostics emitted by route planning. */
    channelRoute: z
      .object({
        method: nonBlankStringSchema,
        pathPattern: nonBlankStringSchema,
      })
      .strict()
      .optional(),
    /** Additional source locations that explain a relationship. */
    related: z
      .array(
        z
          .object({
            label: nonBlankStringSchema,
            nodeId: nonBlankStringSchema,
            logicalPath: nonBlankStringSchema.optional(),
            sourceId: nonBlankStringSchema.optional(),
            sourcePath: nonBlankStringSchema.optional(),
          })
          .strict()
          .refine(
            (locator) =>
              locator.sourceId !== undefined ||
              locator.logicalPath !== undefined ||
              locator.sourcePath !== undefined,
            { message: "A related diagnostic source requires a source locator." },
          ),
      )
      .optional(),
  })
  .strict()
  .refine(
    (diagnostic) =>
      diagnostic.sourceId !== undefined ||
      diagnostic.logicalPath !== undefined ||
      diagnostic.sourcePath !== undefined,
    { message: "A compiler diagnostic requires a source locator." },
  );

/**
 * Summary counts emitted alongside compiler artifacts and CLI output.
 */
export type CompilerDiagnosticsSummary = z.infer<typeof compilerDiagnosticsSummarySchema>;

/**
 * Zod schema for compiler diagnostic summary counts.
 */
export const compilerDiagnosticsSummarySchema = z
  .object({
    errors: z.number().int().nonnegative(),
    warnings: z.number().int().nonnegative(),
  })
  .strict();

/**
 * Creates an error-level compiler diagnostic.
 */
export function createCompilerErrorDiagnostic(
  input: Omit<CompilerDiagnostic, "severity">,
): CompilerDiagnostic {
  return {
    ...input,
    severity: "error",
  };
}

/**
 * Creates a warning-level compiler diagnostic.
 */
export function createCompilerWarningDiagnostic(
  input: Omit<CompilerDiagnostic, "severity">,
): CompilerDiagnostic {
  return {
    ...input,
    severity: "warning",
  };
}

/**
 * Summarizes compiler diagnostics into error and warning counts.
 */
export function summarizeCompilerDiagnostics(
  diagnostics: readonly CompilerDiagnostic[],
): CompilerDiagnosticsSummary {
  return diagnostics.reduce<CompilerDiagnosticsSummary>(
    (summary, diagnostic) => {
      if (diagnostic.severity === "error") {
        summary.errors += 1;
      } else {
        summary.warnings += 1;
      }

      return summary;
    },
    {
      errors: 0,
      warnings: 0,
    },
  );
}

/**
 * Returns whether compiler diagnostics include at least one error.
 */
export function hasCompilerErrors(diagnostics: readonly CompilerDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}

/** Renders one compiler diagnostic with stable code and complete provenance. */
export function formatCompilerDiagnostic(
  diagnostic: CompilerDiagnostic,
  options: { readonly bullet?: boolean } = {},
): string {
  const severity = diagnostic.severity === "error" ? "Error" : "Warning";
  const lines = [
    `${options.bullet === true ? "- " : ""}${severity} [${diagnostic.code}]: ${diagnostic.message}`,
    `  source: ${formatCompilerDiagnosticLocator(diagnostic)}`,
  ];

  for (const related of diagnostic.related ?? []) {
    lines.push(`  related (${related.label}): ${formatCompilerDiagnosticLocator(related)}`);
  }

  return lines.join("\n");
}

function formatCompilerDiagnosticLocator(locator: {
  readonly nodeId: string;
  readonly logicalPath?: string;
  readonly sourceId?: string;
  readonly sourcePath?: string;
}): string {
  return [locator.nodeId, locator.sourcePath, locator.logicalPath, locator.sourceId]
    .filter((value): value is string => value !== undefined)
    .join(" · ");
}

import { z } from "#compiled/zod/index.js";

/**
 * Structured discovery diagnostic severity.
 */
export type DiscoverDiagnosticSeverity = z.infer<typeof discoverDiagnosticSeveritySchema>;

/**
 * Zod schema for structured discovery diagnostic severities.
 */
export const discoverDiagnosticSeveritySchema = z.union([z.literal("error"), z.literal("warning")]);

/**
 * Structured compiler diagnostic emitted while classifying authored sources
 * during discovery, normalizing selected sources, or planning channel
 * routes. Every source-specific locator carries at least one of the
 * `sourcePath`, `sourceId`, or `logicalPath` fields; candidates produced by
 * composition carry both `sourceId` and `logicalPath`, and programmatic
 * sources never fabricate a physical path.
 */
export type DiscoverDiagnostic = z.infer<typeof discoverDiagnosticSchema>;

/**
 * Zod schema for one structured compiler diagnostic.
 */
export const discoverDiagnosticSchema = z
  .object({
    /**
     * Stable machine-readable diagnostic code.
     */
    code: z.string(),
    /**
     * Agent-root-relative logical path associated with the diagnostic.
     */
    logicalPath: z.string().optional(),
    /**
     * Human-readable diagnostic message.
     */
    message: z.string(),
    /**
     * Compiled node id the diagnostic belongs to.
     */
    nodeId: z.string().optional(),
    /**
     * Diagnostic severity.
     */
    severity: discoverDiagnosticSeveritySchema,
    /**
     * Stable source id associated with the diagnostic.
     */
    sourceId: z.string().optional(),
    /**
     * Absolute source path associated with the diagnostic.
     */
    sourcePath: z.string().optional(),
  })
  .strict()
  .refine(
    (diagnostic) =>
      diagnostic.sourcePath !== undefined ||
      diagnostic.sourceId !== undefined ||
      diagnostic.logicalPath !== undefined,
    { message: "A compiler diagnostic requires at least one source locator." },
  );

/**
 * Summary counts emitted alongside discovery manifests and CLI output.
 */
export type DiscoverDiagnosticsSummary = z.infer<typeof discoverDiagnosticsSummarySchema>;

/**
 * Zod schema for discovery diagnostic summary counts.
 */
export const discoverDiagnosticsSummarySchema = z
  .object({
    errors: z.number().finite(),
    warnings: z.number().finite(),
  })
  .strict();

/**
 * Root-resolution error code emitted when discovery cannot locate an eve agent.
 */
export const DISCOVER_PROJECT_NOT_FOUND = "discover/project-not-found";

/**
 * Creates an error-level discovery diagnostic.
 */
export function createDiscoverErrorDiagnostic(
  input: Omit<DiscoverDiagnostic, "severity">,
): DiscoverDiagnostic {
  return {
    ...input,
    severity: "error",
  };
}

/**
 * Creates a warning-level discovery diagnostic.
 */
export function createDiscoverWarningDiagnostic(
  input: Omit<DiscoverDiagnostic, "severity">,
): DiscoverDiagnostic {
  return {
    ...input,
    severity: "warning",
  };
}

/**
 * Summarizes discovery diagnostics into error and warning counts.
 */
export function summarizeDiscoverDiagnostics(
  diagnostics: readonly DiscoverDiagnostic[],
): DiscoverDiagnosticsSummary {
  return diagnostics.reduce<DiscoverDiagnosticsSummary>(
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
 * Returns whether discovery diagnostics include at least one error.
 */
export function hasDiscoverErrors(diagnostics: readonly DiscoverDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}

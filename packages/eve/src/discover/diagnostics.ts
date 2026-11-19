import { z } from "#compiled/zod/index.js";

const discoverDiagnosticSeveritySchema = z.union([z.literal("error"), z.literal("warning")]);

export type DiscoverDiagnostic = z.infer<typeof discoverDiagnosticSchema>;

export const discoverDiagnosticSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    severity: discoverDiagnosticSeveritySchema,
    sourcePath: z.string(),
  })
  .strict();

export type DiscoverDiagnosticsSummary = z.infer<typeof discoverDiagnosticsSummarySchema>;

export const discoverDiagnosticsSummarySchema = z
  .object({
    errors: z.number().finite(),
    warnings: z.number().finite(),
  })
  .strict();

export const DISCOVER_PROJECT_NOT_FOUND = "discover/project-not-found";

export function createDiscoverErrorDiagnostic(
  input: Omit<DiscoverDiagnostic, "severity">,
): DiscoverDiagnostic {
  return {
    ...input,
    severity: "error",
  };
}

export function createDiscoverWarningDiagnostic(
  input: Omit<DiscoverDiagnostic, "severity">,
): DiscoverDiagnostic {
  return {
    ...input,
    severity: "warning",
  };
}

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

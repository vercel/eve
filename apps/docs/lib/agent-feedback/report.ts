import { z } from "zod";

/** The collector rejects feedback longer than this. */
export const MAX_AGENT_FEEDBACK_LENGTH = 10_000;
const MAX_ENCODED_REPORT_LENGTH = 12_000;

export const triggerReasonSchema = z.enum([
  "unexpected-behavior",
  "documentation-mismatch",
  "misleading-error",
  "repeated-failed-approach",
  "non-obvious-workaround",
]);
export const deployTargetSchema = z.enum(["local", "vercel", "self-hosted", "unknown"]);
export const frequencySchema = z.enum(["once", "reproduced"]);
export const outcomeSchema = z.enum(["blocked", "worked-around", "resolved"]);

const shortName = z.string().trim().min(1).max(64);

export const agentFeedbackReportSchema = z.object({
  schemaVersion: z.literal(1),
  title: z.string().trim().min(1).max(100),
  triggerReason: triggerReasonSchema,
  setup: z.object({
    deployTarget: deployTargetSchema,
    relevantFeatures: z.array(z.string().trim().min(1).max(32)).max(3).optional(),
  }),
  steps: z.array(z.string().trim().min(1).max(240)).min(1).max(4),
  observed: z.array(z.string().trim().min(1).max(160)).min(1).max(3),
  expected: z.string().trim().min(1).max(200),
  comparison: z.string().trim().min(1).max(180).optional(),
  frequency: frequencySchema,
  outcome: outcomeSchema,
  eveVersion: shortName,
  agent: shortName,
});

export type AgentFeedbackReport = z.infer<typeof agentFeedbackReportSchema>;

/** Which removable lines the reviewer kept. */
export interface IncludedItems {
  steps: boolean[];
  observed: boolean[];
  comparison: boolean;
}

export const triggerReasonLabels: Record<AgentFeedbackReport["triggerReason"], string> = {
  "unexpected-behavior": "Unexpected behavior",
  "documentation-mismatch": "Documentation mismatch",
  "misleading-error": "Misleading error",
  "repeated-failed-approach": "Repeated failed approach",
  "non-obvious-workaround": "Non-obvious workaround",
};

export const deployTargetLabels: Record<AgentFeedbackReport["setup"]["deployTarget"], string> = {
  local: "Local (eve dev)",
  vercel: "Vercel",
  "self-hosted": "Self-hosted",
  unknown: "Unknown",
};

export const frequencyLabels: Record<AgentFeedbackReport["frequency"], string> = {
  once: "Observed once",
  reproduced: "Reproduced",
};

export const outcomeLabels: Record<AgentFeedbackReport["outcome"], string> = {
  blocked: "Blocked",
  "worked-around": "Worked around",
  resolved: "Resolved",
};

export const includeEverything = (report: AgentFeedbackReport): IncludedItems => ({
  steps: report.steps.map(() => true),
  observed: report.observed.map(() => true),
  comparison: Boolean(report.comparison),
});

const nonEmpty = (values: (string | undefined)[] | undefined) =>
  values?.map((value) => value?.trim()).filter((value): value is string => Boolean(value));

/** Applies the reviewer's removals and returns the report that will be sent, if still valid. */
export const reviewReport = (
  report: AgentFeedbackReport,
  included: IncludedItems,
): AgentFeedbackReport | undefined => {
  const relevantFeatures = nonEmpty(report.setup.relevantFeatures);
  const result = agentFeedbackReportSchema.safeParse({
    ...report,
    setup: {
      ...report.setup,
      relevantFeatures: relevantFeatures?.length ? relevantFeatures : undefined,
    },
    steps: report.steps.filter((step, index) => included.steps[index] && step.trim()),
    observed: report.observed.filter((item, index) => included.observed[index] && item.trim()),
    comparison: included.comparison && report.comparison?.trim() ? report.comparison : undefined,
  });

  return result.success ? result.data : undefined;
};

/** Renders a reviewed report as the plain-text `feedback` the collector stores. */
export const formatReport = (report: AgentFeedbackReport): string => {
  const features = nonEmpty(report.setup.relevantFeatures)?.join(", ");
  const setup = [
    `Trigger: ${triggerReasonLabels[report.triggerReason]}`,
    `Deploy target: ${deployTargetLabels[report.setup.deployTarget]}`,
    ...(features ? [`Relevant features: ${features}`] : []),
    `Frequency: ${frequencyLabels[report.frequency]}`,
    `Outcome: ${outcomeLabels[report.outcome]}`,
  ];

  return [
    report.title,
    "",
    "Setup:",
    ...setup,
    "",
    "How to reproduce:",
    ...report.steps.map((step, index) => `${index + 1}. ${step}`),
    "",
    "Observed:",
    ...report.observed.map((item) => `- ${item}`),
    "",
    "Expected:",
    report.expected,
    ...(report.comparison ? ["", "Control or workaround:", report.comparison] : []),
  ].join("\n");
};

/** Reads the base64url JSON report from a `#report=...` URL hash. */
export const decodeReportHash = (hash: string): AgentFeedbackReport | undefined => {
  const encoded = new URLSearchParams(hash.replace(/^#/, "")).get("report");
  if (!encoded || encoded.length > MAX_ENCODED_REPORT_LENGTH) return undefined;

  try {
    const base64 = encoded.replaceAll("-", "+").replaceAll("_", "/");
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const result = agentFeedbackReportSchema.safeParse(JSON.parse(json));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
};

/** Inverse of {@link decodeReportHash}; agents use the same encoding to build review links. */
export const encodeReportHash = (report: AgentFeedbackReport): string => {
  const bytes = new TextEncoder().encode(JSON.stringify(report));
  const base64 = btoa(String.fromCharCode(...bytes));
  return `#report=${base64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
};

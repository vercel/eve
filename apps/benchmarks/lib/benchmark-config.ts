export const AUTHORING_MODEL = "claude-sonnet-4-6";

export const authoringTreatments = ["baseline", "guided"] as const;

export type AuthoringTreatment = (typeof authoringTreatments)[number];

export const publishedBenchmark = {
  groupId: "claude-sonnet-4-6-claude-code",
  model: AUTHORING_MODEL,
  modelDisplayName: "Claude Sonnet 4.6",
  harness: "Claude Code",
  runs: 3,
} as const;

export function publishedExperimentId(treatment: AuthoringTreatment): string {
  return `${publishedBenchmark.groupId}--${treatment}`;
}

export function parseAuthoringTreatment(value: string): AuthoringTreatment {
  if (authoringTreatments.includes(value as AuthoringTreatment)) {
    return value as AuthoringTreatment;
  }
  throw new Error(
    `Unknown treatment ${JSON.stringify(value)}. Expected one of: ${authoringTreatments.join(", ")}.`,
  );
}

export const authoringTreatments = ["baseline", "guided"] as const;

export type AuthoringTreatment = (typeof authoringTreatments)[number];

export type AuthoringBenchmarkSupport = "supported" | "candidate";

export interface AuthoringBenchmarkModel {
  readonly id: string;
  readonly model: string;
  readonly displayName: string;
  readonly harness: "OpenCode";
  readonly support: AuthoringBenchmarkSupport;
}

export const benchmarkModels = [
  {
    id: "claude-sonnet-4-6",
    model: "claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6",
    harness: "OpenCode",
    support: "candidate",
  },
  {
    id: "kimi-k3",
    model: "moonshotai/kimi-k3",
    displayName: "Kimi K3",
    harness: "OpenCode",
    support: "supported",
  },
  {
    id: "claude-fable-5",
    model: "anthropic/claude-fable-5",
    displayName: "Claude Fable 5",
    harness: "OpenCode",
    support: "supported",
  },
  {
    id: "grok-4-6",
    model: "xai/grok-4.6",
    displayName: "Grok 4.6",
    harness: "OpenCode",
    support: "supported",
  },
  {
    id: "gpt-5-6-sol",
    model: "openai/gpt-5.6-sol",
    displayName: "GPT-5.6 Sol",
    harness: "OpenCode",
    support: "supported",
  },
  {
    id: "gpt-5-6-terra",
    model: "openai/gpt-5.6-terra",
    displayName: "GPT-5.6 Terra",
    harness: "OpenCode",
    support: "supported",
  },
  {
    id: "claude-sonnet-5",
    model: "anthropic/claude-sonnet-5",
    displayName: "Claude Sonnet 5",
    harness: "OpenCode",
    support: "supported",
  },
  {
    id: "glm-5-2",
    model: "zai/glm-5.2",
    displayName: "GLM 5.2",
    harness: "OpenCode",
    support: "supported",
  },
  {
    id: "claude-opus-5",
    model: "anthropic/claude-opus-5",
    displayName: "Claude Opus 5",
    harness: "OpenCode",
    support: "supported",
  },
  {
    id: "gemini-3-1-pro-preview",
    model: "google/gemini-3.1-pro-preview",
    displayName: "Gemini 3.1 Pro Preview",
    harness: "OpenCode",
    support: "supported",
  },
] as const satisfies ReadonlyArray<AuthoringBenchmarkModel>;

export const publishedBenchmarkModels = benchmarkModels.filter(
  (benchmark) => benchmark.support === "supported",
);

export const publishedBenchmark = {
  caseIds: [
    "author-001-weather-tool",
    "author-002-new-project",
    "author-003-openapi-connection",
    "author-004-packaged-skill",
    "author-005-conditional-approval",
    "author-006-custom-channel",
    "author-007-digest-schedule",
  ],
  runs: 3,
} as const;

export function publishedExperimentId(
  benchmark: Pick<AuthoringBenchmarkModel, "id">,
  treatment: AuthoringTreatment,
): string {
  return `${benchmark.id}-opencode--${treatment}`;
}

export function parseAuthoringTreatment(value: string): AuthoringTreatment {
  if (authoringTreatments.includes(value as AuthoringTreatment)) {
    return value as AuthoringTreatment;
  }
  throw new Error(
    `Unknown treatment ${JSON.stringify(value)}. Expected one of: ${authoringTreatments.join(", ")}.`,
  );
}

export function findBenchmarkModel(value: string): AuthoringBenchmarkModel {
  const benchmark = benchmarkModels.find(
    (candidate) => candidate.id === value || candidate.model === value,
  );
  if (benchmark !== undefined) return benchmark;
  throw new Error(
    `Unknown model ${JSON.stringify(value)}. Expected one of: ${benchmarkModels
      .map((candidate) => candidate.id)
      .join(", ")}.`,
  );
}

export function findPublishedBenchmarkModel(value: string): AuthoringBenchmarkModel {
  const benchmark = publishedBenchmarkModels.find(
    (candidate) => candidate.id === value || candidate.model === value,
  );
  if (benchmark !== undefined) return benchmark;
  throw new Error(
    `Model ${JSON.stringify(value)} is not in the supported publication set. Expected one of: ${publishedBenchmarkModels.map((candidate) => candidate.id).join(", ")}.`,
  );
}

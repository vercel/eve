import { configSchema } from "../../extension/lib/config.js";
import type {
  Candidate,
  Cohort,
  Evidence,
  Experiment,
  Observation,
} from "../../extension/lib/types.js";

export const BASE = "a".repeat(40),
  HEAD = "b".repeat(40),
  MERGED = "c".repeat(40);
export function config(overrides: Record<string, unknown> = {}) {
  return configSchema.parse({
    instance: "fixture",
    project: {
      teamId: "team_fixture",
      projectId: "prj_fixture",
      productionUrl: "https://fixture.example.com",
    },
    repository: { owner: "fixture", name: "agent" },
    owner: { authenticator: "basic", principalId: "owner" },
    models: { analyst: "fixture/analyst", maintainer: "fixture/maintainer" },
    credentials: { github: async () => "fixture-token", vercel: async () => "fixture-token" },
    privacy: { hmacSecret: () => "fixture-hmac-secret-with-at-least-32-characters" },
    ...overrides,
  });
}
export const candidate = (): Candidate => ({
  branch: "eve-evolve/fixture",
  head: HEAD,
  base: BASE,
  pr: 1,
  url: "https://github.com/fixture/agent/pull/1",
  changedPaths: ["agent/tool.ts"],
  addressedThreads: [],
  publishedAt: 1,
});
export const experiment = (): Experiment => ({
  id: "fixture",
  createdAt: 1,
  updatedAt: 1,
  rootSession: "root-fixture",
  status: "coding",
  base: BASE,
  finding: {
    id: "failure-fixture",
    target: "search",
    metric: "failure",
    count: 2,
    samples: 10,
    principals: 2,
    summary: "Two observed tool failures",
  },
  attempts: 1,
  checks: [],
});
export const cohort = (overrides: Partial<Cohort> = {}): Cohort => ({
  sampleSize: 20,
  quality: 0.8,
  correctionRate: 0.1,
  failureRate: 0.1,
  p95LatencyMs: 1000,
  costPerSessionUsd: 0.01,
  ...overrides,
});
export const observation = (id: number, overrides: Partial<Observation> = {}): Observation => ({
  id: `observation-${id}`,
  at: 1000 + id,
  session: `session-${id}`,
  turn: `turn-${id}`,
  principal: `principal-${id % 2}`,
  kind: "tool",
  target: "search",
  outcome: "completed",
  durationMs: 100,
  ...overrides,
});
export const evidence = (observations: Observation[] = []): Evidence => ({
  window: { from: 1, to: 100 },
  complete: true,
  reasons: [],
  runs: [],
  observations,
  observationsComplete: true,
});
export const requestFixture = (
  fn: (url: URL, init?: RequestInit) => Promise<Response> | Response,
): typeof fetch =>
  ((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(
      fn(new URL(input instanceof Request ? input.url : String(input)), init),
    )) as typeof fetch;

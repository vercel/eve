import type { SandboxSession } from "eve/sandbox";
import type { AgentReasoningDefinition, AgentStaticModelDefinition } from "eve";

/** The observed state of one independent verification check. */
export type Verdict = "passed" | "failed" | "unavailable" | "pending";
/** One named verification result and the evidence or limitation behind it. */
export interface Check {
  name: string;
  status: Verdict;
  reason: string;
  url?: string;
}
export interface Window {
  from: number;
  to: number;
}
export interface Run {
  id: string;
  status: string;
  model?: string;
  deploymentId?: string;
  createdAt: number;
  completedAt?: number;
  scheduled: boolean;
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
}
export interface Observation {
  id: string;
  at: number;
  session: string;
  turn: string;
  principal: string;
  kind: "tool" | "turn" | "reply" | "feedback";
  target: string;
  outcome?: string;
  durationMs?: number;
  fingerprint?: string;
  feedback?: "correction" | "success" | "failure";
  confidence?: number;
  revision?: string;
}
export interface Evidence {
  window: Window;
  complete: boolean;
  reasons: string[];
  runs: Run[];
  observations: Observation[];
  observationsComplete: boolean;
}
/** A capability or UX signal that can justify an improvement. */
export type Metric = "correction" | "failure" | "latency" | "redundancy";
/** An aggregate issue with its supporting sample and principal counts. */
export interface Finding {
  id: string;
  target: string;
  metric: Metric;
  count: number;
  samples: number;
  principals: number;
  summary: string;
}
/** A falsifiable finding, proposed change, and executable regression plan. */
export interface Hypothesis {
  findingId: string;
  hypothesis: string;
  change: string;
  regression: string;
}
/** Real comparable quality, failure, correction, latency, and optional cost measurements. */
export interface Cohort {
  sampleSize: number;
  quality: number;
  correctionRate: number;
  failureRate: number;
  p95LatencyMs: number;
  costPerSessionUsd?: number;
}
/** Application-specific behavior proof for one immutable candidate head. */
export interface ChangeProof {
  status: Verdict;
  reason: string;
  head: string;

  /** Real measurements, never generated or inferred by the maintainer. */
  metrics?: {
    before: Cohort;
    after: Cohort;
    target: "quality" | "correctionRate" | "failureRate" | "p95LatencyMs";
  };
}
/** An immutable Vercel deployment and its verified project, team, source, and environment. */
export interface Deployment {
  id: string;
  url: string;
  sha: string;
  projectId: string;
  teamId: string;
  environment: "production" | "preview";
  ready: boolean;
}
/** Runtime verification with an explicit causal judgment for rollback. */
export interface RuntimeProof {
  status: Verdict;
  reason: string;
  deploymentId: string;

  /** Set only after correlating an observed regression with this release. */
  causedByRelease?: boolean;
}
/** A confirmed idempotent host-bot delivery with a receipt URL. */
export interface Receipt {
  status: "sent" | "already-sent";
  id: string;
  url: string;
}
/** Forge evidence with bounded display text and digests of the complete contents. */
export interface ReviewFeedback {
  comments: { id: string; body: string; url: string }[];
  commentsDigest?: string;
  omittedComments?: number;
  threads: {
    id: string;
    resolved: boolean;
    outdated: boolean;
    body: string;
    canAutoResolve?: boolean;
  }[];
  threadsDigest?: string;
  reviews: { id: string; state: string; body: string; submittedAt: string }[];
  reviewsDigest?: string;
}
/** A published branch, exact head, full intended paths, and PR identity. */
export interface Candidate {
  branch: string;
  head: string;
  pr: number;
  url: string;
  base: string;
  changedPaths: string[];
  addressedThreads: string[];
  publishedAt: number;
}
/** A release attempt, its saved known-good baseline, verification, and rollback state. */
export interface Release {
  sha: string;
  baseline: Deployment;
  baselineChecks: Check[];
  deployment?: Deployment;
  checks?: Check[];
  verifiedAt?: number;
  deployStartedAt?: number;
  deployAttempts?: number;
  rollback?: { deployment: Deployment; checks: Check[]; revertedBy?: Candidate };
}
/** The durable finding-to-release state, pending operations, and recovery intent. */
export interface Experiment {
  id: string;
  createdAt: number;
  updatedAt: number;
  rootSession: string;
  coordinatorSession?: string;
  writerSession?: string;
  status:
    | "analyzing"
    | "coding"
    | "review"
    | "ready"
    | "merging"
    | "deploying"
    | "monitoring"
    | "shipped"
    | "merged"
    | "superseded"
    | "rejected"
    | "blocked"
    | "rolled-back";
  base: string;
  finding: Finding;
  hypothesis?: Hypothesis;
  attempts: number;
  candidate?: Candidate;
  checks: Check[];
  feedback?: ReviewFeedback;
  attemptedHead?: string;
  verifiedHead?: string;
  previewHead?: string;
  reviewedDigest?: string;
  reviewDigest?: string;
  release?: Release;
  reason?: string;
  publishIntent?: {
    expectedHead: string;
    digest: string;
    paths: string[];
    summary: string;
    addressedThreads: string[];
  };
  baseUpdate?: { expectedHead: string; base: string; startedAt: number; attempts: number };
}
export interface Lease {
  owner: string;
  fence: number;
  until: number;
}
export interface Active {
  lease: Lease;
  experiment: Experiment | null;
}
/** A nightly decision, available evidence, experiment links, and next-action reason. */
export interface Report {
  id: string;
  date: string;
  status: string;
  checks: Check[];
  findings: Finding[];
  experiment?: Pick<Experiment, "id" | "status" | "reason" | "candidate" | "release">;
  usage?: { runs: number; pricedRuns: number; reportedCostUsd: number | null };
}

/** An independent analyst or maintainer model and its actual context and reasoning settings. */
export type RoleModel =
  | AgentStaticModelDefinition
  | {
      model: AgentStaticModelDefinition;
      modelContextWindowTokens?: number;
      reasoning?: AgentReasoningDefinition;
    };
/** Host-owned identities, services, models, policy, proofs, reporting, and trusted release configuration. */
export interface SelfImprovementOptions {
  instance: string;
  project: { teamId: string; projectId: string; productionUrl: string };
  repository: { owner: string; name: string; branch?: string; directory?: string };

  /** Trusted authenticator identity; never infer ownership from a message. */
  owner: { authenticator: string; principalId: string };
  models: { analyst: RoleModel; maintainer: RoleModel };

  /** Standard five-field UTC cron; a fixed expression shifts local time across DST. */
  cron?: string;
  credentials?: { github?: () => Promise<string>; vercel?: () => Promise<string> };

  /** Private Blob by default; select Postgres explicitly with database or databaseUrl. */
  database?: "blob" | "postgres" | "vercel-postgres";
  databaseUrl?: () => string;
  privacy?: { retentionDays?: number; ledgerDays?: number; hmacSecret?: () => string };
  policy?: {
    mode?: "propose" | "ship";
    requiredChecks?: string[];
    protectedPaths?: string[];
    maxAttempts?: number;
    maxFiles?: number;
    maxBytes?: number;
  };

  /** Trusted release service outside candidate/build sandboxes; run eve CLI there. */
  release?: {
    deploy: (input: {
      sha: string;
      project: SelfImprovementOptions["project"];
      repository: SelfImprovementOptions["repository"];
    }) => Promise<void>;
  };
  verification?: {
    /** Trusted commands outside the candidate; defaults to existing test/typecheck/build scripts. */
    commands?: string[];

    /** Auth is attached only after Vercel confirms the exact deployment identity. */
    authHeaders?: (environment: "production" | "preview") => Promise<Record<string, string>>;
    smoke?: { message: string; toolName: string; expectedOutput: unknown };
    change?: (input: {
      baseline: string;
      candidate: Candidate;
      preview: Deployment;
    }) => Promise<ChangeProof>;
    runtime?: (input: { deployment: Deployment; baseline?: Deployment }) => Promise<RuntimeProof>;

    /** Independent idempotent release-delivery proof; absent means messaging was not verified. */
    delivery?: (input: { id: string; deployment: Deployment }) => Promise<Receipt>;
    publisher?: (input: { sha: string; deployment: Deployment }) => Promise<Check>;
  };

  /** Reports through the host bot/connector with a stable idempotency ID and confirmed receipt. */
  report?: (report: Report) => Promise<Receipt>;
}
export interface HostedRunner {
  checkout(sandbox: SandboxSession, sha: string): Promise<void>;
  verify(candidate: Candidate): Promise<Check[]>;
  deploy(sha: string): Promise<void>;
}

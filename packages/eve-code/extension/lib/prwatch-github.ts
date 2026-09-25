import { deleteTokenCacheEntry, getToken } from "@vercel/connect";
import { z } from "zod";

import extension from "../extension.ts";

const GITHUB_API = "https://api.github.com";

export const RepoSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/u)
  .transform((value) => value.toLowerCase());

export const PullRequestWatchInputSchema = z.object({
  repo: RepoSchema,
  pullRequestNumber: z.number().int().positive(),
  reviewOwner: z.string().trim().min(1),
  redHeadOid: z
    .string()
    .regex(/^[0-9a-f]{40}$/iu)
    .transform((oid) => oid.toLowerCase()),
});

export type PullRequestWatchInput = z.infer<typeof PullRequestWatchInputSchema>;

export const PrwatchDeleteInputSchema = z.object({
  repo: RepoSchema,
  pullRequestNumber: z.number().int().positive(),
});

export type PrwatchDeleteInput = z.infer<typeof PrwatchDeleteInputSchema>;

const PullRequestSchema = z.object({
  head: z.object({ sha: z.string().min(1) }),
  html_url: z.string().url(),
  merged: z.boolean().optional().default(false),
  state: z.enum(["open", "closed"]),
});

const ReviewSchema = z.object({
  commit_id: z.string().nullable(),
  state: z.string(),
  submitted_at: z.string().nullable(),
  user: z.object({ login: z.string() }).nullable(),
});

type PullRequest = z.infer<typeof PullRequestSchema>;
type Review = z.infer<typeof ReviewSchema>;

export interface PullRequestWatchSnapshot {
  readonly headOid: string;
  readonly ownerApprovedCurrentHead: boolean;
  readonly ownerReviewState: string | null;
  readonly ownerReviewSubmittedAt: string | null;
  readonly state: "open" | "closed" | "merged";
  readonly url: string;
}

export interface PullRequestWatchNotificationState {
  readonly previousSnapshot: PullRequestWatchSnapshot | null;
  readonly redHeadPolls: number;
  readonly redHeadWakeSent: boolean;
}

export type PullRequestWatchWakeReason =
  | "head_changed"
  | "owner_review_changed"
  | "red_head_stalled";

export function initialPullRequestWatchNotificationState(): PullRequestWatchNotificationState {
  return {
    previousSnapshot: null,
    redHeadPolls: 0,
    redHeadWakeSent: false,
  };
}

export function framePullRequestWatchWake(instruction: string): string {
  return (
    `${instruction}\n\n` +
    "This is an internal watch wake, not a request for a progress report. Continue any necessary " +
    "work. Send a user-facing response only when the original request is complete or a new blocker " +
    "requires human input. Do not report that nothing changed or that work is still in progress."
  );
}

function reviewFingerprint(snapshot: PullRequestWatchSnapshot | null): string | null {
  if (snapshot?.ownerReviewState === null || snapshot === null) return null;
  return `${snapshot.ownerReviewState}:${snapshot.ownerReviewSubmittedAt ?? ""}`;
}

export function advancePullRequestWatchNotification(input: {
  readonly redHeadOid: string;
  readonly snapshot: PullRequestWatchSnapshot;
  readonly staleAfterPolls: number;
  readonly state: PullRequestWatchNotificationState;
}): {
  readonly state: PullRequestWatchNotificationState;
  readonly wakeReason: PullRequestWatchWakeReason | null;
} {
  const previous = input.state.previousSnapshot;
  const headChanged = input.snapshot.headOid !== (previous?.headOid ?? input.redHeadOid);
  const ownerReviewChanged =
    previous !== null && reviewFingerprint(input.snapshot) !== reviewFingerprint(previous);
  const onRedHead = input.snapshot.headOid === input.redHeadOid;
  const redHeadPolls = onRedHead ? input.state.redHeadPolls + 1 : 0;
  let wakeReason: PullRequestWatchWakeReason | null = null;
  if (headChanged) wakeReason = "head_changed";
  else if (ownerReviewChanged) wakeReason = "owner_review_changed";
  else if (onRedHead && !input.state.redHeadWakeSent && redHeadPolls === input.staleAfterPolls) {
    wakeReason = "red_head_stalled";
  }
  return {
    state: {
      previousSnapshot: input.snapshot,
      redHeadPolls,
      redHeadWakeSent: input.state.redHeadWakeSent || wakeReason === "red_head_stalled",
    },
    wakeReason,
  };
}

class RetryablePullRequestWatchError extends Error {}

class GitHubWatchResponseError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "GitHubWatchResponseError";
    this.status = status;
  }
}

function errorStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("status" in error)) return null;
  return typeof error.status === "number" ? error.status : null;
}

export function shouldRefreshPullRequestWatchToken(error: unknown): boolean {
  return errorStatus(error) === 401;
}

export function isRetryablePullRequestWatchError(error: unknown): boolean {
  const status = errorStatus(error);
  return (
    status === 429 ||
    (status !== null && status >= 500) ||
    error instanceof RetryablePullRequestWatchError ||
    error instanceof TypeError ||
    (error instanceof Error &&
      (/^GitHub watch (?:request|token request) failed:/u.test(error.message) ||
        /\((?:429|5\d{2})\b/u.test(error.message)))
  );
}

export function pullRequestWatchSnapshot(input: {
  readonly pullRequest: PullRequest;
  readonly reviewOwner: string;
  readonly reviews: readonly Review[];
}): PullRequestWatchSnapshot {
  const owner = input.reviewOwner.toLowerCase();
  const headOid = input.pullRequest.head.sha.toLowerCase();
  const currentHeadReviews = input.reviews.filter(
    (review) =>
      review.commit_id?.toLowerCase() === headOid && review.user?.login.toLowerCase() === owner,
  );
  const latest = currentHeadReviews.at(-1);

  return {
    headOid,
    ownerApprovedCurrentHead: latest?.state.toUpperCase() === "APPROVED",
    ownerReviewState: latest?.state.toUpperCase() ?? null,
    ownerReviewSubmittedAt: latest?.submitted_at ?? null,
    state: input.pullRequest.merged ? "merged" : input.pullRequest.state,
    url: input.pullRequest.html_url,
  };
}

function repoParts(repo: string): { readonly owner: string; readonly name: string } {
  const [owner, name] = repo.split("/");
  if (owner === undefined || name === undefined) {
    throw new Error(`Invalid GitHub repository: ${repo}`);
  }
  return { owner, name };
}

export function repoFullName(repo: string): string {
  const parts = repoParts(repo);
  return `${parts.owner}/${parts.name}`;
}

function repoApiPath(repo: string): string {
  const parts = repoParts(repo);
  return `/repos/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.name)}`;
}

function redactGithubToken(value: string, token: string): string {
  return token.length === 0 ? value : value.split(token).join("[redacted]");
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function githubTokenParams(org: string, repoName: string) {
  return {
    authorizationDetails: [
      {
        org,
        repositories: [repoName],
        type: "github_app_installation" as const,
      },
    ],
    subject: { type: "app" as const },
  };
}

async function mintWatchToken(repo: string): Promise<string> {
  const github = extension.config.github;
  if (github === undefined) throw new Error("GitHub is not configured for this agent.");
  const parts = repoParts(repo);
  if (parts.owner !== github.org.toLowerCase()) {
    throw new Error(`Repository ${repo} is outside ${github.org}.`);
  }
  const token = await getToken(github.connector, githubTokenParams(github.org, parts.name));
  if (token.length === 0) {
    throw new Error(`Connect returned an empty GitHub token for ${repo}.`);
  }
  return token;
}

async function invalidateWatchToken(repo: string): Promise<void> {
  const github = extension.config.github;
  if (github === undefined) return;
  const parts = repoParts(repo);
  deleteTokenCacheEntry(github.connector, githubTokenParams(github.org, parts.name));
}

async function githubJson(url: string, token: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { headers: githubHeaders(token) });
  } catch (error) {
    throw new RetryablePullRequestWatchError(
      `GitHub watch request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (response.ok) return response.json();
  const detail = await response.text().catch(() => "");
  const message =
    `GitHub request failed (${response.status} ${response.statusText})` +
    (detail.length > 0 ? `: ${redactGithubToken(detail, token)}` : "");
  if (response.status === 429 || response.status >= 500) {
    throw new RetryablePullRequestWatchError(message);
  }
  throw new GitHubWatchResponseError(response.status, message);
}

async function readPullRequestWatchSnapshotWithToken(
  input: PullRequestWatchInput,
  token: string,
): Promise<PullRequestWatchSnapshot> {
  const base = `${GITHUB_API}${repoApiPath(input.repo)}/pulls/${input.pullRequestNumber}`;
  const pullRequest = PullRequestSchema.parse(await githubJson(base, token));
  if (pullRequest.state === "closed" || pullRequest.merged) {
    return pullRequestWatchSnapshot({ pullRequest, reviewOwner: input.reviewOwner, reviews: [] });
  }

  const reviews: Review[] = [];
  for (let page = 1; page <= 20; page += 1) {
    const batch = z
      .array(ReviewSchema)
      .parse(await githubJson(`${base}/reviews?per_page=100&page=${page}`, token));
    reviews.push(...batch);
    if (batch.length < 100) break;
    if (page === 20)
      throw new Error(`PR #${input.pullRequestNumber} has too many reviews to verify`);
  }
  return pullRequestWatchSnapshot({ pullRequest, reviewOwner: input.reviewOwner, reviews });
}

export async function readPullRequestWatchSnapshot(
  input: PullRequestWatchInput,
): Promise<PullRequestWatchSnapshot> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let token: string;
    try {
      token = await mintWatchToken(input.repo);
    } catch (error) {
      if (!isRetryablePullRequestWatchError(error)) throw error;
      throw new RetryablePullRequestWatchError(
        `GitHub watch token request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      return await readPullRequestWatchSnapshotWithToken(input, token);
    } catch (error) {
      if (attempt > 0 || !shouldRefreshPullRequestWatchToken(error)) throw error;
      await invalidateWatchToken(input.repo);
    }
  }
  throw new Error("Pull request watch token refresh exhausted unexpectedly.");
}

/**
 * Minimal GitHub REST/GraphQL wrapper used by the GitHub channel.
 *
 * eve exposes channel-owned helper types and functions instead of leaking a
 * third-party SDK through public channel APIs.
 */

import {
  resolveGitHubInstallationToken,
  type GitHubAuthApiOptions,
  type GitHubChannelCredentials,
} from "#public/channels/github/auth.js";
import { isObject } from "#shared/guards.js";
import { parseJsonObject, type JsonObject } from "#shared/json.js";

/** JSON object accepted by GitHub helper calls. */
export type GitHubJsonObject = JsonObject;

/** HTTP methods supported by the low-level GitHub request helper. */
export type GitHubApiMethod = "DELETE" | "GET" | "PATCH" | "POST" | "PUT";

/**
 * Transport options for GitHub API calls: `apiBaseUrl` (defaults to
 * `https://api.github.com`) and a custom `fetch` (defaults to the global
 * `fetch`).
 */
export interface GitHubApiOptions extends GitHubAuthApiOptions {}

/** Options for {@link GitHubHandle.request}. */
export interface GitHubRequestOptions {
  readonly auth?: boolean;
  readonly headers?: Readonly<Record<string, string>>;
  readonly installationId?: number;
}

/**
 * Successful (2xx) GitHub API response; non-2xx throws {@link GitHubApiError},
 * so `ok` is always true here. `T` is the parsed JSON body type.
 */
export interface GitHubApiResponse<T = unknown> {
  readonly body: T;
  readonly ok: boolean;
  readonly status: number;
}

/** Error thrown for non-2xx GitHub REST and GraphQL responses. */
export class GitHubApiError extends Error {
  readonly body: unknown;
  readonly method: string;
  readonly path: string;
  readonly status: number;

  constructor(input: {
    readonly body: unknown;
    readonly method: string;
    readonly path: string;
    readonly status: number;
  }) {
    super(`GitHub ${input.method} ${input.path} failed with HTTP ${input.status}.`);
    this.name = "GitHubApiError";
    this.body = input.body;
    this.method = input.method;
    this.path = input.path;
    this.status = input.status;
  }
}

/** Body accepted by GitHub comment-writing helpers. */
export interface GitHubCommentBody {
  readonly body: string;
}

/**
 * Posted-comment result from thread helpers. `id` is the GitHub comment id (0 if
 * absent), `htmlUrl`/`url` are undefined when GitHub omits them, and `raw` holds
 * the untyped original response for escape-hatch access.
 */
export interface GitHubPostedComment {
  readonly htmlUrl: string | undefined;
  readonly id: number;
  readonly raw: unknown;
  readonly url: string | undefined;
}

/** GitHub reaction contents supported by the Reactions REST API. */
export type GitHubReactionContent =
  | "+1"
  | "-1"
  | "confused"
  | "eyes"
  | "heart"
  | "hooray"
  | "laugh"
  | "rocket";

interface GitHubResourceInput {
  readonly api?: GitHubApiOptions;
  readonly credentials?: GitHubChannelCredentials;
  readonly installationId?: number;
  readonly owner: string;
  readonly repo: string;
}

/**
 * Calls a GitHub REST API path with installation-token auth by default. Pass
 * `options.auth: false` for unauthenticated reads.
 */
export async function callGitHubApi<T = unknown>(input: {
  readonly api?: GitHubApiOptions;
  readonly body?: GitHubJsonObject;
  readonly credentials?: GitHubChannelCredentials;
  readonly installationId?: number;
  readonly method: GitHubApiMethod;
  readonly path: string;
  readonly options?: GitHubRequestOptions;
}): Promise<GitHubApiResponse<T>> {
  const apiFetch = input.api?.fetch ?? fetch;
  const authEnabled = input.options?.auth !== false;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    ...input.options?.headers,
  };
  if (input.body !== undefined) {
    headers["content-type"] = "application/json; charset=utf-8";
  }
  if (authEnabled) {
    const token = await resolveGitHubInstallationToken({
      api: input.api,
      credentials: input.credentials,
      installationId: input.options?.installationId ?? input.installationId,
    });
    headers.authorization = `Bearer ${token}`;
  }

  const response = await apiFetch(
    `${input.api?.apiBaseUrl ?? "https://api.github.com"}${input.path}`,
    {
      body: input.body === undefined ? undefined : JSON.stringify(parseJsonObject(input.body)),
      headers,
      method: input.method,
    },
  );
  const body = (await parseResponseBody(response)) as T;
  if (!response.ok) {
    throw new GitHubApiError({
      body,
      method: input.method,
      path: input.path,
      status: response.status,
    });
  }
  return { body, ok: response.ok, status: response.status };
}

/** Creates an issue or PR timeline comment. */
export async function createGitHubIssueComment(
  input: GitHubResourceInput & {
    readonly body: string | GitHubCommentBody;
    readonly issueNumber: number;
  },
): Promise<GitHubPostedComment> {
  const response = await callGitHubApi({
    api: input.api,
    body: normalizeCommentBody(input.body),
    credentials: input.credentials,
    installationId: input.installationId,
    method: "POST",
    path: `/repos/${encodePath(input.owner)}/${encodePath(input.repo)}/issues/${
      input.issueNumber
    }/comments`,
  });
  return toPostedComment(response.body);
}

/** Updates an issue or PR timeline comment. */
export async function updateGitHubIssueComment(
  input: GitHubResourceInput & {
    readonly body: string | GitHubCommentBody;
    readonly commentId: number;
  },
): Promise<GitHubPostedComment> {
  const response = await callGitHubApi({
    api: input.api,
    body: normalizeCommentBody(input.body),
    credentials: input.credentials,
    installationId: input.installationId,
    method: "PATCH",
    path: `/repos/${encodePath(input.owner)}/${encodePath(input.repo)}/issues/comments/${
      input.commentId
    }`,
  });
  return toPostedComment(response.body);
}

/** Replies to an inline pull-request review comment thread. */
export async function createGitHubReviewCommentReply(
  input: GitHubResourceInput & {
    readonly body: string | GitHubCommentBody;
    readonly commentId: number;
    readonly pullRequestNumber: number;
  },
): Promise<GitHubPostedComment> {
  const response = await callGitHubApi({
    api: input.api,
    body: normalizeCommentBody(input.body),
    credentials: input.credentials,
    installationId: input.installationId,
    method: "POST",
    path: `/repos/${encodePath(input.owner)}/${encodePath(input.repo)}/pulls/${
      input.pullRequestNumber
    }/comments/${input.commentId}/replies`,
  });
  return toPostedComment(response.body);
}

/** Updates an inline pull-request review comment or reply. */
export async function updateGitHubPullRequestReviewComment(
  input: GitHubResourceInput & {
    readonly body: string | GitHubCommentBody;
    readonly commentId: number;
  },
): Promise<GitHubPostedComment> {
  const response = await callGitHubApi({
    api: input.api,
    body: normalizeCommentBody(input.body),
    credentials: input.credentials,
    installationId: input.installationId,
    method: "PATCH",
    path: `/repos/${encodePath(input.owner)}/${encodePath(input.repo)}/pulls/comments/${
      input.commentId
    }`,
  });
  return toPostedComment(response.body);
}

/** Creates a pull-request review. */
export function createGitHubPullRequestReview(
  input: GitHubResourceInput & {
    readonly body: GitHubJsonObject;
    readonly pullRequestNumber: number;
  },
): Promise<GitHubApiResponse> {
  return callGitHubApi({
    api: input.api,
    body: input.body,
    credentials: input.credentials,
    installationId: input.installationId,
    method: "POST",
    path: `/repos/${encodePath(input.owner)}/${encodePath(input.repo)}/pulls/${
      input.pullRequestNumber
    }/reviews`,
  });
}

/** Creates an inline pull-request review comment. */
export async function createGitHubPullRequestReviewComment(
  input: GitHubResourceInput & {
    readonly body: GitHubJsonObject;
    readonly pullRequestNumber: number;
  },
): Promise<GitHubPostedComment> {
  const response = await callGitHubApi({
    api: input.api,
    body: input.body,
    credentials: input.credentials,
    installationId: input.installationId,
    method: "POST",
    path: `/repos/${encodePath(input.owner)}/${encodePath(input.repo)}/pulls/${
      input.pullRequestNumber
    }/comments`,
  });
  return toPostedComment(response.body);
}

/** Minimal pull-request metadata returned by {@link getGitHubPullRequest}. */
export interface GitHubPullRequestDetails {
  readonly additions: number | undefined;
  readonly author: GitHubPullRequestUser | undefined;
  readonly base: GitHubPullRequestRefDetails;
  readonly body: string | undefined;
  readonly changedFiles: number | undefined;
  readonly defaultBranch: string | undefined;
  readonly deletions: number | undefined;
  readonly draft: boolean;
  readonly head: GitHubPullRequestRefDetails;
  readonly htmlUrl: string | undefined;
  readonly mergeable: boolean | null | undefined;
  readonly number: number;
  readonly raw: unknown;
  readonly state: string | undefined;
  readonly title: string;
}

/** Minimal pull-request author metadata. */
export interface GitHubPullRequestUser {
  readonly id: number;
  readonly login: string;
  readonly type: string;
}

/** Minimal pull-request branch metadata. */
export interface GitHubPullRequestRefDetails {
  readonly ref: string | undefined;
  readonly repoFullName: string | undefined;
  readonly sha: string | undefined;
}

/** Fetches pull-request metadata for context injection and checkout resolution. */
export async function getGitHubPullRequest(
  input: GitHubResourceInput & {
    readonly pullRequestNumber: number;
  },
): Promise<GitHubPullRequestDetails> {
  const response = await callGitHubApi({
    api: input.api,
    credentials: input.credentials,
    installationId: input.installationId,
    method: "GET",
    path: `/repos/${encodePath(input.owner)}/${encodePath(input.repo)}/pulls/${
      input.pullRequestNumber
    }`,
  });
  return toPullRequestDetails(response.body);
}

/** Minimal pull-request file metadata returned by {@link listGitHubPullRequestFiles}. */
export interface GitHubPullRequestFile {
  readonly additions: number | undefined;
  readonly changes: number | undefined;
  readonly deletions: number | undefined;
  readonly filename: string;
  readonly patch: string | undefined;
  readonly status: string | undefined;
}

/** Lists files changed by a pull request. */
export async function listGitHubPullRequestFiles(
  input: GitHubResourceInput & {
    readonly perPage?: number;
    readonly pullRequestNumber: number;
  },
): Promise<readonly GitHubPullRequestFile[]> {
  const perPage = input.perPage === undefined ? "" : `?per_page=${Math.min(input.perPage, 100)}`;
  const response = await callGitHubApi<unknown[]>({
    api: input.api,
    credentials: input.credentials,
    installationId: input.installationId,
    method: "GET",
    path: `/repos/${encodePath(input.owner)}/${encodePath(input.repo)}/pulls/${
      input.pullRequestNumber
    }/files${perPage}`,
  });
  return response.body.map(toPullRequestFile);
}

/** Creates a reaction on a GitHub issue or review comment. */
export function createGitHubReaction(
  input: GitHubResourceInput & {
    readonly commentId: number;
    readonly content: GitHubReactionContent;
    readonly subject: "issue_comment" | "pull_request_review_comment";
  },
): Promise<GitHubApiResponse> {
  const segment = input.subject === "issue_comment" ? "issues/comments" : "pulls/comments";
  return callGitHubApi({
    api: input.api,
    body: { content: input.content },
    credentials: input.credentials,
    installationId: input.installationId,
    method: "POST",
    options: {
      headers: { accept: "application/vnd.github+json" },
    },
    path: `/repos/${encodePath(input.owner)}/${encodePath(input.repo)}/${segment}/${
      input.commentId
    }/reactions`,
  });
}

/** Fetches repository metadata, primarily to resolve `repository.id` for receive(). */
export async function getGitHubRepository(
  input: GitHubResourceInput & { readonly auth?: boolean },
): Promise<{ readonly id: number; readonly defaultBranch: string | undefined }> {
  const response = await callGitHubApi({
    api: input.api,
    credentials: input.credentials,
    installationId: input.installationId,
    method: "GET",
    options: { auth: input.auth ?? input.installationId !== undefined },
    path: `/repos/${encodePath(input.owner)}/${encodePath(input.repo)}`,
  });
  const body = isObject(response.body) ? response.body : {};
  const id = typeof body.id === "number" ? body.id : 0;
  const defaultBranch = typeof body.default_branch === "string" ? body.default_branch : undefined;
  return { defaultBranch, id };
}

function normalizeCommentBody(body: string | GitHubCommentBody): GitHubJsonObject {
  return { body: typeof body === "string" ? body : body.body };
}

function toPostedComment(raw: unknown): GitHubPostedComment {
  const body = isObject(raw) ? raw : {};
  return {
    htmlUrl: typeof body.html_url === "string" ? body.html_url : undefined,
    id: typeof body.id === "number" ? body.id : 0,
    raw,
    url: typeof body.url === "string" ? body.url : undefined,
  };
}

function toPullRequestFile(raw: unknown): GitHubPullRequestFile {
  const file = isObject(raw) ? raw : {};
  return {
    additions: typeof file.additions === "number" ? file.additions : undefined,
    changes: typeof file.changes === "number" ? file.changes : undefined,
    deletions: typeof file.deletions === "number" ? file.deletions : undefined,
    filename: typeof file.filename === "string" ? file.filename : "",
    patch: typeof file.patch === "string" ? file.patch : undefined,
    status: typeof file.status === "string" ? file.status : undefined,
  };
}

function toPullRequestDetails(raw: unknown): GitHubPullRequestDetails {
  const body = isObject(raw) ? raw : {};
  const base = toPullRequestRefDetails(body.base);
  return {
    additions: typeof body.additions === "number" ? body.additions : undefined,
    author: toPullRequestUser(body.user),
    base,
    body: typeof body.body === "string" && body.body.length > 0 ? body.body : undefined,
    changedFiles: typeof body.changed_files === "number" ? body.changed_files : undefined,
    defaultBranch: readDefaultBranch(body.base),
    deletions: typeof body.deletions === "number" ? body.deletions : undefined,
    draft: body.draft === true,
    head: toPullRequestRefDetails(body.head),
    htmlUrl: typeof body.html_url === "string" ? body.html_url : undefined,
    mergeable:
      typeof body.mergeable === "boolean" || body.mergeable === null ? body.mergeable : undefined,
    number: typeof body.number === "number" ? body.number : 0,
    raw,
    state: typeof body.state === "string" ? body.state : undefined,
    title: typeof body.title === "string" ? body.title : "",
  };
}

function toPullRequestRefDetails(raw: unknown): GitHubPullRequestRefDetails {
  const ref = isObject(raw) ? raw : {};
  const repo = isObject(ref.repo) ? ref.repo : {};
  return {
    ref: typeof ref.ref === "string" ? ref.ref : undefined,
    repoFullName: typeof repo.full_name === "string" ? repo.full_name : undefined,
    sha: typeof ref.sha === "string" ? ref.sha : undefined,
  };
}

function toPullRequestUser(raw: unknown): GitHubPullRequestUser | undefined {
  if (!isObject(raw) || typeof raw.login !== "string") return undefined;
  return {
    id: typeof raw.id === "number" ? raw.id : 0,
    login: raw.login,
    type: typeof raw.type === "string" ? raw.type : "User",
  };
}

function readDefaultBranch(raw: unknown): string | undefined {
  const ref = isObject(raw) ? raw : {};
  const repo = isObject(ref.repo) ? ref.repo : {};
  return typeof repo.default_branch === "string" ? repo.default_branch : undefined;
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function encodePath(segment: string): string {
  return encodeURIComponent(segment);
}

import { createHash } from "node:crypto";

import {
  captureSelfModificationProposal,
  readProposalBlob,
  type PreparedSelfModificationWorkspace,
  type ProposalChange,
  type SelfModificationCommandSandbox,
  type SelfModificationPersonalAccessTokenResolver,
  type SelfModificationProposal,
  type SelfModificationRepository,
} from "./git-workspace.js";
import {
  assertFullSha,
  assertGitRef,
  assertOperationId,
  assertRepositoryPart,
} from "./identifiers.js";

const API_BASE_URL = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 30_000;
const USER_AGENT = "eve-self-modification";
const MAX_TITLE_LENGTH = 256;
const MAX_BODY_LENGTH = 65_536;
const MAX_ERROR_DETAIL_LENGTH = 500;

/** GitHub requires a mode on every tree entry, including the entries that delete a path. */
const DELETED_ENTRY_MODE = "100644";

export interface PublishSelfModificationProposalInput {
  readonly body: string;
  readonly personalAccessToken: SelfModificationPersonalAccessTokenResolver;
  readonly deployedSha: string;
  readonly fetch?: typeof fetch;
  readonly operationId: string;
  readonly repository: SelfModificationRepository;
  readonly sandbox: SelfModificationCommandSandbox;
  readonly workspace: PreparedSelfModificationWorkspace;
  readonly title: string;
}

export interface PublishedSelfModificationProposal {
  readonly base: string;
  readonly branch: string;
  readonly changedPaths: readonly string[];
  readonly commitSha: string;
  readonly deployedSha: string;
  readonly draft: boolean;
  readonly pullRequestState: "closed" | "open";
  readonly pullRequestUrl: string;
}

interface GitHubRef {
  readonly object: { readonly sha: string };
  readonly ref: string;
}

interface GitHubCommit {
  readonly parents: readonly { readonly sha: string }[];
  readonly sha: string;
  readonly tree: { readonly sha: string };
}

interface GitHubPullRequest {
  readonly draft: boolean;
  readonly html_url: string;
  readonly number: number;
  readonly state: "closed" | "open";
}

interface GitHubTreeEntry {
  readonly mode: string;
  readonly path: string;
  readonly sha: string | null;
  readonly type: "blob";
}

export function selfModificationBranchName(deployedSha: string, operationId: string): string {
  assertFullSha(deployedSha, "deployed revision");
  return `eve-self-modification/${deployedSha.slice(0, 12)}/${hashOperationId(operationId)}`;
}

export async function publishSelfModificationProposal(
  input: PublishSelfModificationProposalInput,
): Promise<PublishedSelfModificationProposal> {
  assertPublicationInput(input);

  const proposal = await captureSelfModificationProposal({
    sandbox: input.sandbox,
    workspace: input.workspace,
  });
  const branch = selfModificationBranchName(input.deployedSha, input.operationId);
  const token = await input.personalAccessToken();
  if (typeof token !== "string" || token.trim().length === 0) {
    throw new Error("Self-modification publication requires a GitHub personal access token.");
  }
  const github = new GitHubPublisherClient({ fetch: input.fetch ?? fetch, token: token.trim() });

  const existingRef = await github.getRef(input.repository, branch);
  if (existingRef !== null) {
    return await reconcileExistingPublication({
      branch,
      github,
      input,
      proposal,
      ref: existingRef,
    });
  }

  const baseRef = await github.getRef(input.repository, input.repository.pullRequestBase);
  if (baseRef === null) {
    throw new Error(
      `Self-modification pull request base "${input.repository.pullRequestBase}" does not exist in ${input.repository.owner}/${input.repository.repo}.`,
    );
  }
  if (baseRef.object.sha !== input.workspace.baseSha) {
    throw new Error(
      "Self-modification pull request base moved while the proposal was being prepared.",
    );
  }

  const commitSha = await uploadProposal({ github, input, proposal });
  try {
    await github.createRef(input.repository, branch, commitSha);
  } catch (error) {
    const racedRef = await github.getRef(input.repository, branch);
    if (racedRef === null) throw error;
    return await reconcileExistingPublication({ branch, github, input, proposal, ref: racedRef });
  }

  const pullRequest = await github.createPullRequest(
    input.repository,
    pullRequestPayload(input, branch),
  );
  return publishedProposal({ branch, commitSha, input, proposal, pullRequest });
}

/**
 * Resolves a replayed publication against what this operation already published.
 *
 * Both comparisons use locally captured Git object ids, so reconciliation neither writes
 * to the repository nor trusts the retry to describe the earlier attempt.
 */
async function reconcileExistingPublication(context: {
  readonly branch: string;
  readonly github: GitHubPublisherClient;
  readonly input: PublishSelfModificationProposalInput;
  readonly proposal: SelfModificationProposal;
  readonly ref: GitHubRef;
}): Promise<PublishedSelfModificationProposal> {
  const { branch, github, input, proposal, ref } = context;
  const existingCommit = await github.getCommit(input.repository, ref.object.sha);
  if (existingCommit.parents.length !== 1 || existingCommit.parents[0]?.sha !== proposal.baseSha) {
    throw new Error(
      `Self-modification operation conflict: ${branch} targets a different pull request base revision than this proposal.`,
    );
  }
  if (existingCommit.tree.sha !== proposal.proposedTreeSha) {
    throw new Error(
      "Self-modification operation conflict: this operation already published a different proposal.",
    );
  }

  const pullRequest =
    (await github.findPullRequest(input.repository, branch)) ??
    (await github.createPullRequest(input.repository, pullRequestPayload(input, branch)));
  return publishedProposal({ branch, commitSha: ref.object.sha, input, proposal, pullRequest });
}

async function uploadProposal(context: {
  readonly github: GitHubPublisherClient;
  readonly input: PublishSelfModificationProposalInput;
  readonly proposal: SelfModificationProposal;
}): Promise<string> {
  const treeSha = await uploadProposalTree(context);
  return await context.github.createCommit(context.input.repository, {
    // No author or committer: GitHub attributes the commit to the account that owns the
    // personal access token, which is the operator accountable for the proposal. A
    // synthetic author would only add unverifiable metadata.
    message: `eve self-modification proposal\n\nOperation: ${hashOperationId(context.input.operationId)}`,
    parent: context.proposal.baseSha,
    tree: treeSha,
  });
}

async function uploadProposalTree(context: {
  readonly github: GitHubPublisherClient;
  readonly input: PublishSelfModificationProposalInput;
  readonly proposal: SelfModificationProposal;
}): Promise<string> {
  const tree: GitHubTreeEntry[] = [];
  for (const change of context.proposal.changes) tree.push(await uploadTreeEntry(context, change));
  const treeSha = await context.github.createTree(
    context.input.repository,
    context.proposal.baseTreeSha,
    tree,
  );
  // Git trees are content addressed, so an identical id proves GitHub reassembled exactly
  // the tree that proposal capture checked against the path and size policy.
  if (treeSha !== context.proposal.proposedTreeSha) {
    throw new Error("Self-modification proposal did not reassemble into the validated Git tree.");
  }
  return treeSha;
}

async function uploadTreeEntry(
  context: {
    readonly github: GitHubPublisherClient;
    readonly input: PublishSelfModificationProposalInput;
  },
  change: ProposalChange,
): Promise<GitHubTreeEntry> {
  if (change.objectId === null || change.mode === null) {
    return { mode: DELETED_ENTRY_MODE, path: change.path, sha: null, type: "blob" };
  }
  const content = await readProposalBlob({
    change,
    sandbox: context.input.sandbox,
    workspace: context.input.workspace,
  });
  const sha = await context.github.createBlob(context.input.repository, content);
  return { mode: change.mode, path: change.path, sha, type: "blob" };
}

function assertPublicationInput(input: PublishSelfModificationProposalInput): void {
  assertFullSha(input.workspace.baseSha, "proposal base revision");
  assertFullSha(input.workspace.deployedSha, "workspace deployed revision");
  assertFullSha(input.deployedSha, "deployed revision");
  if (input.workspace.deployedSha !== input.deployedSha) {
    throw new Error("Self-modification workspace does not match the deployed revision.");
  }
  assertRepositoryPart(input.repository.owner, "repository owner");
  assertRepositoryPart(input.repository.repo, "repository name");
  assertGitRef(input.repository.pullRequestBase);
  if (
    input.title.trim().length === 0 ||
    input.title.length > MAX_TITLE_LENGTH ||
    hasControlCharacter(input.title)
  ) {
    throw new Error(
      `Self-modification pull request title must be a single line of 1-${MAX_TITLE_LENGTH} characters.`,
    );
  }
  if (input.body.length > MAX_BODY_LENGTH) {
    throw new Error("Self-modification pull request body is too large.");
  }
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });
}

function pullRequestPayload(input: PublishSelfModificationProposalInput, branch: string) {
  return {
    base: input.repository.pullRequestBase,
    body: input.body,
    branch,
    title: input.title.trim(),
  };
}

function publishedProposal(context: {
  readonly branch: string;
  readonly commitSha: string;
  readonly input: PublishSelfModificationProposalInput;
  readonly proposal: SelfModificationProposal;
  readonly pullRequest: GitHubPullRequest;
}): PublishedSelfModificationProposal {
  return {
    base: context.input.repository.pullRequestBase,
    branch: context.branch,
    changedPaths: context.proposal.changes.map((change) => change.path),
    commitSha: context.commitSha,
    deployedSha: context.input.deployedSha,
    draft: context.pullRequest.draft,
    pullRequestState: context.pullRequest.state,
    pullRequestUrl: context.pullRequest.html_url,
  };
}

class GitHubPublisherClient {
  readonly #fetch: typeof fetch;
  readonly #token: string;

  constructor(input: { readonly fetch: typeof fetch; readonly token: string }) {
    this.#fetch = input.fetch;
    this.#token = input.token;
  }

  async getRef(repository: SelfModificationRepository, branch: string): Promise<GitHubRef | null> {
    const payload = await this.#request(
      repository,
      "GET",
      `/git/ref/${encodeRefPath(`heads/${branch}`)}`,
      undefined,
      true,
    );
    if (payload === null) return null;
    // GitHub answers an ambiguous ref prefix with every match; only an exact ref counts.
    if (Array.isArray(payload)) return null;
    const record = asRecord(payload, "ref");
    if (record.ref !== `refs/heads/${branch}`) {
      throw new Error("GitHub returned an unexpected self-modification ref.");
    }
    const object = asRecord(record.object, "ref");
    return { object: { sha: asSha(object.sha, "GitHub ref revision") }, ref: record.ref };
  }

  async getCommit(repository: SelfModificationRepository, sha: string): Promise<GitHubCommit> {
    assertFullSha(sha, "GitHub commit revision");
    const record = asRecord(
      await this.#request(repository, "GET", `/git/commits/${encodeURIComponent(sha)}`),
      "commit",
    );
    if (!Array.isArray(record.parents)) {
      throw new Error("GitHub returned an unexpected commit response.");
    }
    return {
      parents: record.parents.map((parent) => ({
        sha: asSha(asRecord(parent, "commit parent").sha, "GitHub parent revision"),
      })),
      sha: asSha(record.sha, "GitHub commit revision"),
      tree: { sha: asSha(asRecord(record.tree, "commit tree").sha, "GitHub tree revision") },
    };
  }

  async createBlob(repository: SelfModificationRepository, content: string): Promise<string> {
    const record = asRecord(
      await this.#request(repository, "POST", "/git/blobs", { content, encoding: "base64" }),
      "blob",
    );
    return asSha(record.sha, "GitHub blob");
  }

  async createTree(
    repository: SelfModificationRepository,
    baseTree: string,
    tree: readonly GitHubTreeEntry[],
  ): Promise<string> {
    const record = asRecord(
      await this.#request(repository, "POST", "/git/trees", { base_tree: baseTree, tree }),
      "tree",
    );
    return asSha(record.sha, "GitHub tree");
  }

  async createCommit(
    repository: SelfModificationRepository,
    input: { readonly message: string; readonly parent: string; readonly tree: string },
  ): Promise<string> {
    const record = asRecord(
      await this.#request(repository, "POST", "/git/commits", {
        message: input.message,
        parents: [input.parent],
        tree: input.tree,
      }),
      "commit",
    );
    return asSha(record.sha, "GitHub commit");
  }

  async createRef(
    repository: SelfModificationRepository,
    branch: string,
    commitSha: string,
  ): Promise<void> {
    await this.#request(repository, "POST", "/git/refs", {
      ref: `refs/heads/${branch}`,
      sha: commitSha,
    });
  }

  async findPullRequest(
    repository: SelfModificationRepository,
    branch: string,
  ): Promise<GitHubPullRequest | null> {
    const query = new URLSearchParams({
      base: repository.pullRequestBase,
      head: `${repository.owner}:${branch}`,
      state: "all",
    });
    const payload = await this.#request(repository, "GET", `/pulls?${query}`);
    if (!Array.isArray(payload)) {
      throw new Error("GitHub returned an unexpected pull request list.");
    }
    const first = payload[0];
    return first === undefined ? null : validatePullRequest(repository, branch, first);
  }

  async createPullRequest(
    repository: SelfModificationRepository,
    input: {
      readonly base: string;
      readonly body: string;
      readonly branch: string;
      readonly title: string;
    },
  ): Promise<GitHubPullRequest> {
    const pullRequest = validatePullRequest(
      repository,
      input.branch,
      await this.#request(repository, "POST", "/pulls", {
        base: input.base,
        body: input.body,
        draft: true,
        head: input.branch,
        title: input.title,
      }),
    );
    // The draft state is the review boundary, so a pull request that opened ready for
    // review is a publication failure rather than a cosmetic difference.
    if (!pullRequest.draft) {
      throw new Error("GitHub did not open the self-modification pull request as a draft.");
    }
    return pullRequest;
  }

  async #request(
    repository: SelfModificationRepository,
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
    allowNotFound = false,
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${this.#token}`,
      "user-agent": USER_AGENT,
      "x-github-api-version": "2022-11-28",
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await this.#fetch(
      `${API_BASE_URL}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}${path}`,
      {
        body: body === undefined ? undefined : JSON.stringify(body),
        headers,
        method,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    if (allowNotFound && response.status === 404) return null;
    if (!response.ok) throw await requestError(method, path, response);
    return await response.json();
  }
}

/** GitHub routes a ref as a multi-segment path; percent-encoded separators do not match. */
function encodeRefPath(ref: string): string {
  return ref.split("/").map(encodeURIComponent).join("/");
}

function validatePullRequest(
  repository: SelfModificationRepository,
  branch: string,
  payload: unknown,
): GitHubPullRequest {
  const record = asRecord(payload, "pull request");
  const { draft, html_url: htmlUrl, number, state } = record;
  if (
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    number <= 0 ||
    htmlUrl !== `https://github.com/${repository.owner}/${repository.repo}/pull/${number}` ||
    typeof draft !== "boolean" ||
    (state !== "closed" && state !== "open") ||
    asRecord(record.head, "pull request head").ref !== branch ||
    asRecord(record.base, "pull request base").ref !== repository.pullRequestBase
  ) {
    throw new Error("GitHub returned an invalid self-modification pull request.");
  }
  return { draft, html_url: htmlUrl, number, state };
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`GitHub returned an unexpected ${context} response.`);
  }
  return value as Record<string, unknown>;
}

function asSha(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`SelfModification ${label} must be a full Git SHA.`);
  }
  assertFullSha(value, label);
  return value;
}

/**
 * Turns a GitHub failure into a message an operator can act on.
 *
 * GitHub explains permission, plan, and rate limit failures in the response body, and
 * that body never carries credential material, so it is safe to surface.
 */
async function requestError(method: string, path: string, response: Response): Promise<Error> {
  const details = [`HTTP ${response.status}`];
  const message = await responseMessage(response);
  if (message.length > 0) details.push(message);
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter !== null && (response.status === 403 || response.status === 429)) {
    details.push(`retry after ${retryAfter}s`);
  }
  return new Error(`GitHub ${method} ${path} failed: ${details.join("; ")}.`);
}

async function responseMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  if (text.length === 0) return "";
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return collapse(text);
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return collapse(text);
  }
  const record = payload as Record<string, unknown>;
  const message = typeof record.message === "string" ? record.message : "";
  const errors = Array.isArray(record.errors)
    ? record.errors
        .map(describeResponseError)
        .filter((entry) => entry.length > 0)
        .join(", ")
    : "";
  const combined = [message, errors].filter((entry) => entry.length > 0).join(" - ");
  return collapse(combined.length === 0 ? text : combined);
}

function describeResponseError(entry: unknown): string {
  if (typeof entry === "string") return entry;
  if (typeof entry !== "object" || entry === null) return "";
  const record = entry as Record<string, unknown>;
  if (typeof record.message === "string") return record.message;
  return [record.resource, record.field, record.code]
    .filter((part): part is string => typeof part === "string")
    .join(".");
}

function collapse(value: string): string {
  const single = value.replaceAll(/\s+/gu, " ").trim();
  return single.length > MAX_ERROR_DETAIL_LENGTH
    ? `${single.slice(0, MAX_ERROR_DETAIL_LENGTH)}...`
    : single;
}

function hashOperationId(operationId: string): string {
  assertOperationId(operationId);
  return createHash("sha256").update(operationId).digest("hex").slice(0, 24);
}

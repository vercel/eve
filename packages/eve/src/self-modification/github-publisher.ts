import { createHash } from "node:crypto";

import type { GitHubRepository } from "./config.js";
import type { GitHubCredentialProvider } from "./credentials.js";
import type { PreparedSelfModificationWorkspace } from "./git-workspace.js";
import { assertFullSha, assertGitRef, assertOperationId } from "./identifiers.js";
import {
  captureSelfModificationProposal,
  readProposalBlob,
  type SelfModificationProposal,
} from "./proposal.js";

const API = "https://api.github.com";
const TIMEOUT_MS = 30_000;
const DELETED_ENTRY_MODE = "100644";

export interface PublishedSelfModificationProposal {
  readonly changedPaths: readonly string[];
  readonly commitSha: string;
  readonly pullRequestUrl: string;
  readonly repository: string;
  readonly targetBranch: string;
  readonly branch: string;
  readonly draft: true;
  readonly merged: false;
  readonly deployed: false;
}

export interface GitHubDraftPublisherInput {
  readonly credentialProvider: GitHubCredentialProvider;
  readonly description: string;
  readonly fetch?: typeof fetch;
  /** Derived by the trusted parent/session lineage, never from model tool input. */
  readonly operationId: string;
  readonly sandbox: Parameters<typeof captureSelfModificationProposal>[0]["sandbox"];
  readonly title: string;
  readonly workspace: PreparedSelfModificationWorkspace;
}

/** Captures agent-only edits, then publishes one replay-safe draft pull request. */
export async function publishGitHubDraftPullRequest(
  input: GitHubDraftPublisherInput,
): Promise<PublishedSelfModificationProposal> {
  assertOperationId(input.operationId);
  validateText(input.title, "title", 256, false);
  validateText(input.description, "description", 65_536, true);
  const proposal = await captureSelfModificationProposal({
    sandbox: input.sandbox,
    workspace: input.workspace,
  });
  const branch = selfModificationBranchName(input.workspace.baseSha, input.operationId);
  // Deliberately after capture: a model can never obtain a publication credential by
  // submitting an invalid proposal.
  const token = await input.credentialProvider.resolve({
    capability: "publish",
    repository: repository(input.workspace),
  });
  if (token.trim().length === 0)
    throw new Error("Self-modification publication credential is empty.");
  const github = new GitHubClient(input.fetch ?? fetch, token.trim());
  await assertTargetAtBase(
    github,
    repository(input.workspace),
    input.workspace.targetBranch,
    proposal.baseSha,
  );
  const existing = await github.ref(repository(input.workspace), branch);
  if (existing !== null) return await reconcile(github, input, proposal, branch, existing);

  const commitSha = await upload(github, input, proposal);
  try {
    await github.createRef(repository(input.workspace), branch, commitSha);
  } catch (error) {
    const raced = await github.ref(repository(input.workspace), branch);
    if (raced === null) throw error;
    return await reconcile(github, input, proposal, branch, raced);
  }
  await assertTargetAtBase(
    github,
    repository(input.workspace),
    input.workspace.targetBranch,
    proposal.baseSha,
  );
  const pullRequest = await github.createPullRequest(
    repository(input.workspace),
    branch,
    input.workspace.targetBranch,
    input.title.trim(),
    body(input.description, proposal),
  );
  return receipt(input.workspace, proposal, branch, commitSha, pullRequest);
}

export function selfModificationBranchName(baseSha: string, operationId: string): string {
  assertFullSha(baseSha, "proposal base revision");
  assertOperationId(operationId);
  return `eve-self-modification/${baseSha.slice(0, 12)}/${createHash("sha256").update(operationId).digest("hex").slice(0, 24)}`;
}

async function reconcile(
  github: GitHubClient,
  input: GitHubDraftPublisherInput,
  proposal: SelfModificationProposal,
  branch: string,
  commitSha: string,
): Promise<PublishedSelfModificationProposal> {
  const commit = await github.commit(repository(input.workspace), commitSha);
  if (commit.parent !== proposal.baseSha)
    throw new Error("Self-modification operation conflict: existing branch has a different base.");
  if (commit.tree !== proposal.proposedTreeSha)
    throw new Error("Self-modification operation conflict: existing branch has different edits.");
  const pr = await github.pullRequest(
    repository(input.workspace),
    branch,
    input.workspace.targetBranch,
  );
  if (pr === null) {
    await assertTargetAtBase(
      github,
      repository(input.workspace),
      input.workspace.targetBranch,
      proposal.baseSha,
    );
    return receipt(
      input.workspace,
      proposal,
      branch,
      commitSha,
      await github.createPullRequest(
        repository(input.workspace),
        branch,
        input.workspace.targetBranch,
        input.title.trim(),
        body(input.description, proposal),
      ),
    );
  }
  if (!pr.draft)
    throw new Error("Self-modification operation conflict: its pull request is no longer a draft.");
  return receipt(input.workspace, proposal, branch, commitSha, pr);
}

async function upload(
  github: GitHubClient,
  input: GitHubDraftPublisherInput,
  proposal: SelfModificationProposal,
): Promise<string> {
  const entries = await Promise.all(
    proposal.changes.map(async (change) => {
      if (change.objectId === null)
        return { mode: DELETED_ENTRY_MODE, path: change.path, sha: null, type: "blob" as const };
      return {
        mode: change.mode!,
        path: change.path,
        sha: await github.blob(
          repository(input.workspace),
          await readProposalBlob({ change, sandbox: input.sandbox, workspace: input.workspace }),
        ),
        type: "blob" as const,
      };
    }),
  );
  const tree = await github.tree(repository(input.workspace), proposal.baseTreeSha, entries);
  if (tree !== proposal.proposedTreeSha)
    throw new Error("GitHub did not reassemble the validated proposal tree.");
  return await github.commitCreate(
    repository(input.workspace),
    proposal.baseSha,
    tree,
    `eve self-modification proposal\n\nOperation: ${createHash("sha256").update(input.operationId).digest("hex").slice(0, 24)}`,
  );
}

async function assertTargetAtBase(
  github: GitHubClient,
  repo: GitHubRepository,
  target: string,
  base: string,
): Promise<void> {
  assertGitRef(target);
  const ref = await github.ref(repo, target);
  if (ref === null)
    throw new Error(`Self-modification target branch ${JSON.stringify(target)} does not exist.`);
  if (ref !== base.toLowerCase())
    throw new Error(
      "Self-modification target branch changed while the proposal was being prepared.",
    );
}

function repository(workspace: PreparedSelfModificationWorkspace): GitHubRepository {
  return workspace.repository;
}

function receipt(
  workspace: PreparedSelfModificationWorkspace,
  proposal: SelfModificationProposal,
  branch: string,
  commitSha: string,
  pr: PullRequest,
): PublishedSelfModificationProposal {
  if (!pr.draft) throw new Error("GitHub did not create a draft self-modification pull request.");
  const repo = repository(workspace);
  return {
    branch,
    changedPaths: proposal.changes.map((change) => change.path),
    commitSha,
    deployed: false,
    draft: true,
    merged: false,
    pullRequestUrl: pr.url,
    repository: `github.com/${repo.owner}/${repo.repo}`,
    targetBranch: workspace.targetBranch,
  };
}

function body(description: string, proposal: SelfModificationProposal): string {
  return `${description}\n\n---\n\nThis is a draft proposal. Merge and deployment have not occurred.\n\n## Changed files\n${proposal.changes.map((change) => `- \`${change.path}\``).join("\n")}`;
}
function validateText(value: string, name: string, maximum: number, multiline: boolean): void {
  if (
    value.trim().length === 0 ||
    value.length > maximum ||
    (!multiline && /[\x00-\x1f\x7f]/u.test(value))
  )
    throw new Error(`Self-modification pull request ${name} is invalid.`);
}

interface PullRequest {
  readonly draft: boolean;
  readonly url: string;
}
class GitHubClient {
  readonly requestFetch: typeof fetch;
  readonly token: string;

  constructor(requestFetch: typeof fetch, token: string) {
    this.requestFetch = requestFetch;
    this.token = token;
  }
  async ref(repo: GitHubRepository, branch: string): Promise<string | null> {
    const value = await this.request(
      repo,
      "GET",
      `/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`,
      undefined,
      true,
    );
    if (value === null || Array.isArray(value) || !record(value).object) return null;
    const sha = record(record(value).object).sha;
    if (typeof sha !== "string") throw new Error("GitHub returned an invalid ref.");
    assertFullSha(sha, "GitHub ref");
    return sha.toLowerCase();
  }
  async commit(repo: GitHubRepository, sha: string): Promise<{ parent: string; tree: string }> {
    const value = record(await this.request(repo, "GET", `/git/commits/${sha}`));
    const parents = value.parents;
    const tree = record(value.tree).sha;
    if (!Array.isArray(parents) || parents.length !== 1 || typeof tree !== "string")
      throw new Error("GitHub returned an invalid commit.");
    const parent = record(parents[0]).sha;
    if (typeof parent !== "string") throw new Error("GitHub returned an invalid commit.");
    assertFullSha(parent, "GitHub parent");
    assertFullSha(tree, "GitHub tree");
    return { parent: parent.toLowerCase(), tree: tree.toLowerCase() };
  }
  async blob(repo: GitHubRepository, content: string): Promise<string> {
    return this.sha(
      await this.request(repo, "POST", "/git/blobs", { content, encoding: "base64" }),
    );
  }
  async tree(repo: GitHubRepository, base: string, tree: unknown): Promise<string> {
    return this.sha(await this.request(repo, "POST", "/git/trees", { base_tree: base, tree }));
  }
  async commitCreate(
    repo: GitHubRepository,
    parent: string,
    tree: string,
    message: string,
  ): Promise<string> {
    return this.sha(
      await this.request(repo, "POST", "/git/commits", { message, parents: [parent], tree }),
    );
  }
  async createRef(repo: GitHubRepository, branch: string, sha: string): Promise<void> {
    await this.request(repo, "POST", "/git/refs", { ref: `refs/heads/${branch}`, sha });
  }
  async pullRequest(
    repo: GitHubRepository,
    branch: string,
    base: string,
  ): Promise<PullRequest | null> {
    // Do not filter by base: an operation-owned pull request retargeted elsewhere is
    // a conflict, not permission to create a second pull request from this branch.
    const query = new URLSearchParams({ head: `${repo.owner}:${branch}`, state: "all" });
    const values = await this.request(repo, "GET", `/pulls?${query}`);
    if (!Array.isArray(values)) throw new Error("GitHub returned an invalid pull request list.");
    return values[0] === undefined ? null : pullRequest(values[0], repo, branch, base);
  }
  async createPullRequest(
    repo: GitHubRepository,
    branch: string,
    base: string,
    title: string,
    body: string,
  ): Promise<PullRequest> {
    return pullRequest(
      await this.request(repo, "POST", "/pulls", { base, body, draft: true, head: branch, title }),
      repo,
      branch,
      base,
    );
  }
  private async sha(value: unknown): Promise<string> {
    const sha = record(value).sha;
    if (typeof sha !== "string") throw new Error("GitHub returned an invalid Git object.");
    assertFullSha(sha, "GitHub object");
    return sha.toLowerCase();
  }
  private async request(
    repo: GitHubRepository,
    method: string,
    path: string,
    body?: unknown,
    missing = false,
  ): Promise<unknown | null> {
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${this.token}`,
      "user-agent": "eve-self-modification",
      "x-github-api-version": "2022-11-28",
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await this.requestFetch(
      `${API}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}${path}`,
      {
        body: body === undefined ? undefined : JSON.stringify(body),
        headers,
        method,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (missing && response.status === 404) return null;
    if (!response.ok)
      throw new Error(`GitHub ${method} ${path} failed with HTTP ${response.status}.`);
    return await response.json();
  }
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("GitHub returned an invalid response.");
  return value as Record<string, unknown>;
}
function pullRequest(
  value: unknown,
  repo: GitHubRepository,
  branch: string,
  base: string,
): PullRequest {
  const result = record(value);
  const draft = result.draft;
  const state = result.state;
  const url = result.html_url;
  if (
    typeof draft !== "boolean" ||
    state !== "open" ||
    typeof url !== "string" ||
    record(result.head).ref !== branch ||
    record(result.base).ref !== base ||
    !url.startsWith(`https://github.com/${repo.owner}/${repo.repo}/pull/`)
  )
    throw new Error("GitHub returned an invalid pull request.");
  return { draft, url };
}

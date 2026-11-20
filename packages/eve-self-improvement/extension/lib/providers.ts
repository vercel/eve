import { credential, digest, type Config } from "./config.js";
import type { Candidate, Deployment, ReviewFeedback } from "./types.js";

function displayBody(body: string): string {
  return body.length > 1000
    ? `${body.slice(0, 900)}\n[Truncated; inspect the PR for full evidence.]`
    : body;
}
function boundBodies<T extends { body: string }>(entries: T[]): T[] {
  let remaining = 20_000;
  return entries
    .slice()
    .reverse()
    .map((entry) => {
      const body = displayBody(entry.body);
      const bytes = Buffer.byteLength(JSON.stringify(body)) - 2;
      if (bytes > remaining) return { ...entry, body: "" };
      remaining -= bytes;
      return { ...entry, body };
    })
    .reverse();
}
export function boundFeedback(feedback: ReviewFeedback): ReviewFeedback {
  const comments: ReviewFeedback["comments"] = [];
  let remaining = 20_000;
  for (const comment of feedback.comments.slice(-50).reverse()) {
    const bounded = { ...comment, body: displayBody(comment.body) };
    const bytes = Buffer.byteLength(JSON.stringify(bounded)) + 1;
    if (bytes > remaining) continue;
    comments.unshift(bounded);
    remaining -= bytes;
  }
  const reviews = boundBodies(feedback.reviews),
    threads = boundBodies(feedback.threads);
  const commentsDigest = feedback.commentsDigest ?? digest(feedback.comments);
  const reviewsDigest = feedback.reviewsDigest ?? digest(feedback.reviews);
  const threadsDigest = feedback.threadsDigest ?? digest(feedback.threads);
  const omittedComments =
    (feedback.omittedComments ?? 0) + feedback.comments.length - comments.length;
  return {
    ...feedback,
    comments,
    commentsDigest,
    omittedComments,
    reviews,
    reviewsDigest,
    threads,
    threadsDigest,
    truncated:
      feedback.truncated === true ||
      omittedComments > 0 ||
      commentsDigest !== digest(comments) ||
      reviewsDigest !== digest(reviews) ||
      threadsDigest !== digest(threads),
  };
}

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
  ) {
    super(`${provider} request failed (HTTP ${status}); response withheld`);
  }
}
export class GitHub {
  readonly repo: string;
  constructor(
    readonly config: Config,
    readonly request: typeof fetch = fetch,
  ) {
    this.repo = `${config.repository.owner}/${config.repository.name}`;
  }
  async api<T = any>(path: string, method = "GET", body?: unknown): Promise<T> {
    const response = await this.request(`https://api.github.com${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await credential(this.config, "github")}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new ProviderError("GitHub", response.status);
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }
  async graphql<T = any>(query: string, variables: Record<string, unknown>): Promise<T> {
    const result = await this.api("/graphql", "POST", { query, variables });
    if (result.errors?.length)
      throw new Error("GitHub GraphQL operation failed; private response withheld");
    return result.data;
  }
  async pages(path: string): Promise<any[]> {
    const result = [];
    for (let page = 1; page <= 10; page++) {
      const rows = await this.api(
        `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
      );
      if (!Array.isArray(rows)) throw new Error("GitHub pagination schema unavailable");
      result.push(...rows);
      if (rows.length < 100) return result;
    }
    throw new Error("GitHub pagination limit reached; review/check evidence incomplete");
  }
  async main(): Promise<string> {
    const ref = await this.api(
      `/repos/${this.repo}/git/ref/heads/${encodeURIComponent(this.config.repository.branch)}`,
    );
    if (!/^[a-f0-9]{40}$/.test(ref.object?.sha))
      throw new Error("GitHub did not return an exact source SHA");
    return ref.object.sha;
  }
  async branch(branch: string): Promise<string | null> {
    try {
      return (await this.api(`/repos/${this.repo}/git/ref/heads/${encodeURIComponent(branch)}`))
        .object.sha;
    } catch (error) {
      if (error instanceof ProviderError && error.status === 404) return null;
      throw error;
    }
  }
  async tree(sha: string): Promise<Map<string, { mode: string; sha: string; type: string }>> {
    const tree = await this.api(`/repos/${this.repo}/git/trees/${sha}?recursive=1`);
    if (tree.truncated || !Array.isArray(tree.tree))
      throw new Error("GitHub tree incomplete; cannot capture candidate safely");
    return new Map(
      tree.tree.map((entry: any) => [
        entry.path,
        { mode: entry.mode, sha: entry.sha, type: entry.type },
      ]),
    );
  }
  async manifest(sha: string): Promise<any> {
    const prefix =
      this.config.repository.directory === "." ? "" : `${this.config.repository.directory}/`;
    const result = await this.api(`/repos/${this.repo}/contents/${prefix}package.json?ref=${sha}`);
    if (result.encoding !== "base64" || typeof result.content !== "string")
      throw new Error("Package manifest unavailable");
    return JSON.parse(Buffer.from(result.content, "base64").toString("utf8"));
  }
  async findPr(branch: string): Promise<any | null> {
    const found = await this.api(
      `/repos/${this.repo}/pulls?state=all&head=${encodeURIComponent(`${this.config.repository.owner}:${branch}`)}&base=${encodeURIComponent(this.config.repository.branch)}&per_page=100`,
    );
    if (!Array.isArray(found) || found.length >= 100)
      throw new Error("Cannot reconcile the candidate PR");
    if (found.length > 1) throw new Error("Multiple candidate PRs require reconciliation");
    return found[0] ?? null;
  }
  async feedback(candidate: Candidate): Promise<ReviewFeedback> {
    const [comments, reviews, inline] = await Promise.all([
      this.pages(`/repos/${this.repo}/issues/${candidate.pr}/comments`),
      this.pages(`/repos/${this.repo}/pulls/${candidate.pr}/reviews`),
      this.pages(`/repos/${this.repo}/pulls/${candidate.pr}/comments`),
    ]);
    const threads: ReviewFeedback["threads"] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const result: any = await this.graphql(
        `query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){nodes{id isResolved isOutdated comments(first:1){nodes{body viewerDidAuthor author{__typename}}}}pageInfo{hasNextPage endCursor}}}}}`,
        {
          owner: this.config.repository.owner,
          name: this.config.repository.name,
          number: candidate.pr,
          cursor,
        },
      );
      const data = result.repository?.pullRequest?.reviewThreads;
      if (!data || !Array.isArray(data.nodes))
        throw new Error("Unresolved review thread evidence unavailable");
      threads.push(
        ...data.nodes.map((t: any) => ({
          id: t.id,
          resolved: t.isResolved,
          outdated: t.isOutdated,
          body: String(t.comments.nodes[0]?.body ?? ""),
          canAutoResolve:
            t.comments.nodes[0]?.viewerDidAuthor === true &&
            t.comments.nodes[0]?.author?.__typename === "Bot",
        })),
      );
      if (!data.pageInfo.hasNextPage)
        return boundFeedback({
          comments: [...comments, ...inline].map((c: any) => ({
            id: String(c.id),
            body: String(c.body ?? ""),
            url: c.html_url,
          })),
          reviews: reviews.map((r: any) => ({
            id: String(r.id),
            state: r.state,
            body: String(r.body ?? ""),
            submittedAt: r.submitted_at,
          })),
          threads,
        });
      if (!data.pageInfo.endCursor || data.pageInfo.endCursor === cursor) break;
      cursor = data.pageInfo.endCursor;
    }
    throw new Error("Review thread pagination incomplete");
  }
  async resolveThread(id: string): Promise<void> {
    await this.graphql(
      "mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}",
      { id },
    );
  }
}
export class Vercel {
  constructor(
    readonly config: Config,
    readonly request: typeof fetch = fetch,
  ) {}
  async api<T = any>(path: string, method = "GET", body?: unknown): Promise<T> {
    const url = new URL(`https://api.vercel.com${path}`);
    url.searchParams.set("teamId", this.config.project.teamId);
    const response = await this.request(url, {
      method,
      headers: {
        authorization: `Bearer ${await credential(this.config, "vercel")}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new ProviderError("Vercel", response.status);
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }
  async deployment(
    idOrUrl: string,
    sha?: string,
    environment?: "production" | "preview",
  ): Promise<Deployment> {
    const value = await this.api(
      `/v13/deployments/${encodeURIComponent(idOrUrl.replace(/^https:\/\//, ""))}`,
    );
    const deployment: Deployment = {
      id: value.id,
      url: `https://${value.url}`,
      sha: value.gitSource?.sha ?? value.meta?.githubCommitSha,
      teamId: value.ownerId,
      projectId: value.projectId,
      environment: value.target === "production" ? "production" : "preview",
      ready: value.readyState === "READY",
    };
    assertDeployment(this.config, deployment, sha, environment);
    return deployment;
  }
  async preview(sha: string): Promise<Deployment | null> {
    const result = await this.api(
      `/v6/deployments?projectId=${this.config.project.projectId}&sha=${sha}&target=preview&limit=100`,
    );
    if (!Array.isArray(result.deployments))
      throw new Error("Vercel deployment metadata unavailable");
    for (const value of result.deployments)
      if ((value.meta?.githubCommitSha ?? value.gitSource?.sha) === sha) {
        try {
          return await this.deployment(value.uid ?? value.id, sha, "preview");
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "Deployment is not READY") throw error;
        }
      }
    return null;
  }
  async deploymentAttempts(sha: string): Promise<{ id: string; state: string }[]> {
    const result = await this.api(
      `/v6/deployments?projectId=${this.config.project.projectId}&sha=${sha}&target=production&limit=100`,
    );
    if (!Array.isArray(result.deployments) || result.deployments.length >= 100)
      throw new Error("Deployment reconciliation is incomplete");
    return result.deployments
      .filter((d: any) => (d.meta?.githubCommitSha ?? d.gitSource?.sha) === sha)
      .map((d: any) => ({ id: d.uid ?? d.id, state: d.readyState ?? d.state }));
  }
  async rollback(baseline: Deployment): Promise<void> {
    assertDeployment(this.config, baseline, baseline.sha, "production");
    await this.api(
      `/v9/projects/${this.config.project.projectId}/rollback/${baseline.id}`,
      "POST",
      {},
    );
  }
}
export function assertDeployment(
  c: Config,
  d: Deployment,
  sha?: string,
  environment?: "production" | "preview",
): void {
  let url: URL;
  try {
    url = new URL(d.url);
  } catch {
    throw new Error("Deployment URL is invalid");
  }
  if (
    !d.id?.startsWith("dpl_") ||
    url.protocol !== "https:" ||
    url.origin !== d.url ||
    url.username ||
    url.password ||
    d.teamId !== c.project.teamId ||
    d.projectId !== c.project.projectId ||
    !/^[a-f0-9]{40}$/.test(d.sha ?? "") ||
    (sha !== undefined && d.sha !== sha) ||
    (environment !== undefined && d.environment !== environment)
  )
    throw new Error(
      "Deployment does not match the exact configured project, team, source and environment",
    );
  if (!d.ready) throw new Error("Deployment is not READY");
}

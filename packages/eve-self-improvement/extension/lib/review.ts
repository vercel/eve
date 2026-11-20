import { checkPath, digest, type Config } from "./config.js";
import { boundFeedback, GitHub } from "./providers.js";
import type { Candidate, Check, Experiment, ReviewFeedback } from "./types.js";

export class MergePolicyBlocked extends Error {}

export interface ReviewInspection {
  checks: Check[];
  feedback: ReviewFeedback;
  outputs: { name: string; text: string; url?: string }[];
  pr: any;
}
export function reviewFingerprint(candidate: Candidate, inspection: ReviewInspection): string {
  return digest([candidate.head, inspection.feedback, inspection.outputs]);
}

export async function reconcileBaseUpdate(
  candidate: Candidate,
  intent: NonNullable<Experiment["baseUpdate"]>,
  git: GitHub,
): Promise<"waiting" | "updated"> {
  const [head, pr] = await Promise.all([
    git.branch(candidate.branch),
    git.api(`/repos/${git.repo}/pulls/${candidate.pr}`),
  ]);
  if (!head || head === intent.expectedHead || pr.head?.sha !== head) return "waiting";
  if (
    pr.head?.ref !== candidate.branch ||
    pr.head?.repo?.full_name?.toLowerCase() !== git.repo.toLowerCase() ||
    pr.base?.ref !== git.config.repository.branch
  )
    throw new Error("Base update changed PR identity");
  const commit = await git.api(`/repos/${git.repo}/commits/${head}`);
  const parents = commit.parents?.map((parent: any) => parent.sha);
  if (
    !commit.commit?.verification?.verified ||
    !Array.isArray(parents) ||
    parents.length !== 2 ||
    !parents.includes(intent.expectedHead) ||
    !parents.includes(intent.base)
  )
    throw new Error(
      "Updated branch does not match the requested signed base merge; reconcile before adopting it",
    );
  candidate.head = head;
  candidate.base = intent.base;
  candidate.publishedAt = Date.now();
  return "updated";
}
export function completePatch(file: {
  patch?: string;
  additions?: number;
  deletions?: number;
}): boolean {
  if (
    typeof file.patch !== "string" ||
    !Number.isSafeInteger(file.additions) ||
    !Number.isSafeInteger(file.deletions)
  )
    return false;
  const lines = file.patch.split("\n");
  return (
    lines.filter((line) => line.startsWith("+")).length === file.additions &&
    lines.filter((line) => line.startsWith("-")).length === file.deletions
  );
}
export async function inspectCandidate(
  c: Config,
  candidate: Candidate,
  git = new GitHub(c),
): Promise<ReviewInspection> {
  const [pr, fetchedFeedback, statuses, files] = await Promise.all([
    git.api(`/repos/${git.repo}/pulls/${candidate.pr}`),
    git.feedback(candidate),
    git.pages(`/repos/${git.repo}/commits/${candidate.head}/statuses`),
    git.pages(`/repos/${git.repo}/pulls/${candidate.pr}/files`),
  ]);
  const feedback = boundFeedback(fetchedFeedback);
  const checks: Check[] = [
      {
        name: "complete review evidence",
        status: feedback.truncated ? "unavailable" : "passed",
        reason: feedback.truncated
          ? "Review text was omitted or truncated; automatic acceptance and merging require complete classified feedback"
          : "Every fetched comment, review and thread body is present in the classification evidence",
      },
    ],
    outputs: ReviewInspection["outputs"] = [];
  const checkRuns: any[] = [];
  for (let page = 1; page <= 10; page++) {
    const result = await git.api(
      `/repos/${git.repo}/commits/${candidate.head}/check-runs?per_page=100&page=${page}`,
    );
    if (!Array.isArray(result.check_runs)) throw new Error("Check-run evidence unavailable");
    checkRuns.push(...result.check_runs);
    if (result.check_runs.length < 100) break;
    if (page === 10) throw new Error("Check-run pagination incomplete");
  }
  for (const run of checkRuns) {
    const annotations = await git.pages(`/repos/${git.repo}/check-runs/${run.id}/annotations`);
    outputs.push({
      name: run.name,
      url: run.details_url,
      text: [
        run.output?.title,
        run.output?.summary,
        run.output?.text,
        ...annotations.map((a) => a.message),
      ]
        .filter(Boolean)
        .join("\n"),
    });
  }
  if (
    pr.head?.sha !== candidate.head ||
    pr.head?.ref !== candidate.branch ||
    pr.head?.repo?.full_name?.toLowerCase() !== git.repo.toLowerCase() ||
    pr.base?.ref !== c.repository.branch
  )
    throw new Error("PR identity/head changed; previous verification is invalid");
  if (!files.length || files.length > c.policy.maxFiles)
    throw new Error("Actual PR diff exceeds the configured scope");
  let diffBytes = 0;
  const [baseTree, headTree] = await Promise.all([
    git.tree(candidate.base),
    git.tree(candidate.head),
  ]);
  for (const file of files) {
    checkPath(c, file.filename);
    if (file.previous_filename) checkPath(c, file.previous_filename);
    const entry = headTree.get(file.filename) ?? baseTree.get(file.filename);
    if (!entry || entry.mode !== "100644" || entry.type !== "blob" || !completePatch(file))
      throw new Error(
        "Actual PR diff contains an unsupported file mode, binary or incomplete patch",
      );
    diffBytes += Buffer.byteLength(file.patch);
  }
  if (diffBytes > c.policy.maxBytes) throw new Error("Actual PR patch exceeds policy");
  outputs.push({
    name: "actual candidate diff",
    text: files.map((file) => `${file.status} ${file.filename}\n${file.patch}`).join("\n\n"),
  });
  checks.push({
    name: "actual diff",
    status: "passed",
    reason: `Inspected ${files.length} files at ${candidate.head}; paths, modes and bounded full patches are supported`,
  });
  const commit = await git.api(`/repos/${git.repo}/commits/${candidate.head}`);
  checks.push({
    name: "verified commit signature",
    status: commit.commit?.verification?.verified === true ? "passed" : "failed",
    reason:
      commit.commit?.verification?.verified === true
        ? "GitHub verified the exact candidate commit"
        : "Signature verification is missing",
  });
  const contexts = new Map<string, { status: string; url?: string }>();
  for (const run of checkRuns.sort((a, b) => Number(b.id) - Number(a.id)))
    if (run.head_sha === candidate.head && !contexts.has(run.name))
      contexts.set(run.name, {
        status: run.status === "completed" ? run.conclusion : "pending",
        url: run.details_url,
      });
  for (const status of statuses)
    if (!contexts.has(status.context))
      contexts.set(status.context, { status: status.state, url: status.target_url });
  if (!c.policy.requiredChecks.length)
    checks.push({
      name: "required checks",
      status: "unavailable",
      reason: "Configure the project's required check contexts before automatic shipping",
    });
  for (const name of c.policy.requiredChecks) {
    const result = contexts.get(name),
      passed = result?.status === "success";
    const pending =
      !result || ["pending", "queued", "in_progress", "waiting"].includes(result.status);
    checks.push({
      name,
      status: passed ? "passed" : pending ? "pending" : "failed",
      reason: passed
        ? "Exact-head check succeeded; output and annotations were read"
        : `Exact-head check is ${result?.status ?? "missing"}; skipped is not success`,
      url: result?.url,
    });
  }
  checks.push({
    name: "resolved conversations",
    status: feedback.threads.every((t) => t.resolved) ? "passed" : "pending",
    reason: `${feedback.threads.filter((t) => !t.resolved).length} unresolved review threads`,
  });
  checks.push({
    name: "up-to-date branch",
    status:
      (await git.main()) === candidate.base && pr.base?.sha === candidate.base
        ? "passed"
        : "pending",
    reason: "Candidate must be based on the current target branch",
  });
  return { checks, feedback, outputs, pr };
}
export async function markReady(git: GitHub, pr: any): Promise<void> {
  if (pr.draft)
    await git.graphql(
      "mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{isDraft}}}",
      { id: pr.node_id },
    );
}
export async function mergeExact(
  c: Config,
  candidate: Candidate,
  reviewedDigest: string,
  git = new GitHub(c),
): Promise<string> {
  const inspection = await inspectCandidate(c, candidate, git);
  if (inspection.checks.some((check) => check.status !== "passed"))
    throw new Error("Exact-head required checks, branch freshness or conversations block merge");
  if (reviewFingerprint(candidate, inspection) !== reviewedDigest)
    throw new Error(
      "Review evidence changed after classification; assess the new feedback before merging",
    );
  const result = await git.graphql(
    `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid isDraft mergeable mergeStateStatus reviewDecision}}}`,
    { owner: c.repository.owner, name: c.repository.name, number: candidate.pr },
  );
  const pr = result.repository?.pullRequest;
  if (
    !pr ||
    pr.headRefOid !== candidate.head ||
    pr.isDraft ||
    pr.mergeable !== "MERGEABLE" ||
    pr.mergeStateStatus !== "CLEAN" ||
    pr.reviewDecision === "CHANGES_REQUESTED" ||
    pr.reviewDecision === "REVIEW_REQUIRED"
  )
    throw new MergePolicyBlocked(
      "GitHub's enforced merge policy blocks this exact head; no bypass attempted",
    );
  const merged = await git.api(`/repos/${git.repo}/pulls/${candidate.pr}/merge`, "PUT", {
    sha: candidate.head,
    merge_method: "squash",
  });
  if (merged.merged !== true || !/^[a-f0-9]{40}$/.test(merged.sha ?? ""))
    throw new Error("Merge outcome unconfirmed; reconcile PR and target before retrying");
  const commit = await git.api(`/repos/${git.repo}/commits/${merged.sha}`);
  if (commit.commit?.verification?.verified !== true)
    throw new Error("Merged commit signature is not verified; release stopped");
  return merged.sha;
}

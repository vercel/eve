import { isScheduleAuth } from "eve/schedules";
import type { ToolContext } from "eve/tools";
import { checkPath, digest, type Config } from "./config.js";
import { GitHub } from "./providers.js";
import { repositoryPath, quote, type WorkingSandbox } from "./hosted.js";
import { store } from "./store.js";
import type { Active, Candidate } from "./types.js";

export async function authorizedActive(
  c: Config,
  ctx: Pick<ToolContext, "session">,
): Promise<Active & { experiment: NonNullable<Active["experiment"]> }> {
  const active = await store(c).active();
  if (
    !isScheduleAuth(ctx.session.auth.current) ||
    !ctx.session.parent ||
    !active?.experiment ||
    active.lease.until <= Date.now() ||
    active.experiment.rootSession !== ctx.session.parent.rootSessionId ||
    active.experiment.coordinatorSession !== ctx.session.parent.sessionId ||
    active.experiment.status !== "coding"
  )
    throw new Error("No authorized active evolution delegation for this session");
  active.experiment = await store(c).bindSession(active.lease, "writerSession", ctx.session.id);
  return active as Active & { experiment: NonNullable<Active["experiment"]> };
}
export async function captureFiles(
  c: Config,
  ctx: { getSandbox(): PromiseLike<Pick<WorkingSandbox, "run" | "readBinaryFile">> },
  git: GitHub,
  expectedHead: string,
  paths: string[],
) {
  if (!paths.length || paths.length > c.policy.maxFiles || new Set(paths).size !== paths.length)
    throw new Error("Candidate file count is empty, duplicated or exceeds policy");
  paths.forEach((path) => checkPath(c, path));
  const tree = await git.tree(expectedHead);
  const sandbox = await ctx.getSandbox();
  const additions: { path: string; contents: string }[] = [],
    deletions: { path: string }[] = [];
  let bytes = 0;
  for (const path of paths) {
    const base = tree.get(path);
    if (base && (base.type !== "blob" || base.mode !== "100644"))
      throw new Error(
        "The signed publisher supports ordinary non-executable files; use a native signing runner for other modes",
      );
    const safety = await sandbox.run({
      command: `python3 -c ${quote("import os,sys,stat; root='/workspace/repository'; path=root;\nfor part in sys.argv[1].split('/'):\n path=os.path.join(path,part)\n if os.path.islink(path): sys.exit(2)\nif os.path.exists(path) and (not os.path.isfile(path) or os.stat(path).st_mode & 0o111): sys.exit(3)\n")} ${quote(path)}`,
    });
    if (safety.exitCode !== 0)
      throw new Error("Candidate contains a symlink, executable or non-file path");
    const content = await sandbox.readBinaryFile({ path: `${repositoryPath}/${path}` });
    if (content === null) {
      if (!base) throw new Error("Deletion does not exist in the trusted base");
      deletions.push({ path });
      continue;
    }
    bytes += content.byteLength;
    if (bytes > c.policy.maxBytes) throw new Error("Candidate exceeds the configured byte limit");
    additions.push({ path, contents: Buffer.from(content).toString("base64") });
  }
  return { additions, deletions };
}
export async function publishCandidate(
  c: Config,
  ctx: ToolContext,
  input: { paths: string[]; summary: string; addressedThreads: string[] },
): Promise<Candidate> {
  const active = await authorizedActive(c, ctx),
    experiment = active.experiment;
  const git = new GitHub(c),
    db = store(c);
  if (await reconcilePublication(c, active, git)) return experiment.candidate!;
  if (
    input.addressedThreads.some(
      (id) => !experiment.feedback?.threads.some((t) => t.id === id && !t.resolved),
    )
  )
    throw new Error("Resolution request names a thread outside the observed review");
  const branch = experiment.candidate?.branch ?? `eve-evolve/${experiment.id}`;
  const expectedHead = experiment.candidate?.head ?? experiment.base;
  const fileChanges = await captureFiles(c, ctx, git, expectedHead, input.paths);
  const operation = digest([experiment.id, expectedHead, fileChanges]);
  experiment.publishIntent = { expectedHead, digest: operation, ...input };
  experiment.updatedAt = Date.now();
  await db.save(active.lease, experiment);
  let remoteHead = await git.branch(branch);
  if (!remoteHead) {
    try {
      await git.api(`/repos/${git.repo}/git/refs`, "POST", {
        ref: `refs/heads/${branch}`,
        sha: expectedHead,
      });
    } catch {
      remoteHead = await git.branch(branch);
      if (!remoteHead) throw new Error("Branch publication unconfirmed; reconcile before retry");
    }
    remoteHead ??= expectedHead;
  }
  let head: string;
  if (remoteHead !== expectedHead) {
    const commit = await git.api(`/repos/${git.repo}/commits/${remoteHead}`);
    if (!String(commit.commit?.message).includes(`Eve-Evolution-Operation: ${operation}`))
      throw new Error("Candidate branch moved unexpectedly; refusing to overwrite it");
    head = remoteHead;
  } else {
    const result = await git.graphql(
      `mutation($input:CreateCommitOnBranchInput!){createCommitOnBranch(input:$input){commit{oid}}}`,
      {
        input: {
          branch: { repositoryNameWithOwner: git.repo, branchName: branch },
          expectedHeadOid: expectedHead,
          message: {
            headline: `evolve: improve ${experiment.finding.metric}`,
            body: `Experiment ${experiment.id}\nEve-Evolution-Operation: ${operation}`,
          },
          fileChanges,
        },
      },
    );
    head = result.createCommitOnBranch?.commit?.oid;
    if (!/^[a-f0-9]{40}$/.test(head ?? ""))
      throw new Error("Signed candidate publication unconfirmed; reconcile before retry");
  }
  const commit = await git.api(`/repos/${git.repo}/commits/${head}`);
  if (commit.commit?.verification?.verified !== true)
    throw new Error("GitHub did not verify the candidate commit signature; merge is blocked");
  let pr = await git.findPr(branch);
  if (pr?.state === "closed")
    throw new Error(
      "This experiment's PR is already closed; record its outcome before another experiment",
    );
  if (!pr) {
    try {
      pr = await git.api(`/repos/${git.repo}/pulls`, "POST", {
        head: branch,
        base: c.repository.branch,
        draft: true,
        title: `Improve ${experiment.finding.target}: ${experiment.finding.metric}`,
        body: `Observed problem: ${experiment.finding.summary}\n\n${experiment.hypothesis?.hypothesis ?? ""}\n\n${input.summary}\n\nValidation runs against this exact head before merge. Experiment: ${experiment.id}.`,
      });
    } catch {
      pr = await git.findPr(branch);
      if (!pr)
        throw new Error("PR publication unconfirmed; reconcile deterministic branch before retry");
    }
  }
  const feedback = experiment.feedback;
  if (
    input.addressedThreads.some((id) => !feedback?.threads.some((t) => t.id === id && !t.resolved))
  )
    throw new Error("Resolution request names a thread outside the observed review");
  const candidate: Candidate = {
    branch,
    head,
    pr: pr.number,
    url: pr.html_url,
    base: experiment.base,
    changedPaths: input.paths,
    addressedThreads: input.addressedThreads,
    publishedAt: Date.now(),
  };
  experiment.candidate = candidate;
  experiment.status = "review";
  experiment.updatedAt = Date.now();
  experiment.checks = [];
  experiment.publishIntent = undefined;
  await db.save(active.lease, experiment);
  return candidate;
}

export async function reconcilePublication(
  c: Config,
  active: Active & { experiment: NonNullable<Active["experiment"]> },
  git = new GitHub(c),
  db = store(c),
): Promise<boolean> {
  const e = active.experiment,
    intent = e.publishIntent;
  if (!intent || e.status !== "coding") return false;
  const branch = e.candidate?.branch ?? `eve-evolve/${e.id}`,
    head = await git.branch(branch);
  if (!head || head === intent.expectedHead) return false;
  const commit = await git.api(`/repos/${git.repo}/commits/${head}`);
  if (
    !commit.commit?.verification?.verified ||
    !String(commit.commit.message).includes(`Eve-Evolution-Operation: ${intent.digest}`)
  )
    throw new Error(
      "An uncertain publication does not match its stored operation/signature; reconcile without overwrite",
    );
  let pr = await git.findPr(branch);
  if (!pr) {
    try {
      pr = await git.api(`/repos/${git.repo}/pulls`, "POST", {
        head: branch,
        base: c.repository.branch,
        draft: true,
        title: `Improve ${e.finding.target}: ${e.finding.metric}`,
        body: `Observed problem: ${e.finding.summary}\n\n${e.hypothesis?.hypothesis ?? ""}\n\n${intent.summary}\n\nExperiment: ${e.id}. Exact-head verification is pending.`,
      });
    } catch {
      pr = await git.findPr(branch);
      if (!pr) throw new Error("Uncertain PR publication remains unresolved");
    }
  }
  e.candidate = {
    branch,
    head,
    base: e.base,
    pr: pr.number,
    url: pr.html_url,
    changedPaths: intent.paths,
    addressedThreads: intent.addressedThreads,
    publishedAt: Date.parse(commit.commit.committer?.date) || Date.now(),
  };
  e.status = "review";
  e.checks = [];
  e.updatedAt = Date.now();
  e.publishIntent = undefined;
  await db.save(active.lease, e);
  return true;
}

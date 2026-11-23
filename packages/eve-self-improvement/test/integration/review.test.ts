import { test } from "node:test";
import assert from "node:assert/strict";
import { GitHub, assertDeployment } from "../../extension/lib/providers.js";
import {
  inspectCandidate,
  mergeExact,
  completePatch,
  reviewFingerprint,
  reconcileBaseUpdate,
} from "../../extension/lib/review.js";
import {
  installCommand,
  validationCommands,
  checkout,
  createHostedRunner,
} from "../../extension/lib/hosted.js";
import { config, candidate, BASE, HEAD, MERGED } from "./fixtures.js";

class FixtureGit extends GitHub {
  calls: { path: string; method: string; body?: any }[] = [];
  checkConclusion = "success";
  unresolved = false;
  head = HEAD;
  decision: string | null = null;
  comment = "Conversation suggestion";
  commentCount = 1;
  reviewBody = "Submitted review";
  threadBody = "Thread finding";
  threadAuthor: { viewerDidAuthor?: boolean; author?: { __typename: string } } = {};
  override async api<T = any>(path: string, method = "GET", body?: unknown): Promise<T> {
    this.calls.push({ path, method, body });
    let result: any;
    if (path.includes("/annotations?")) result = [{ message: "Inline setup diagnostic" }];
    else if (path.includes("/check-runs?"))
      result = {
        check_runs: [
          {
            id: 42,
            name: "Vercel Agent Review",
            head_sha: HEAD,
            status: "completed",
            conclusion: this.checkConclusion,
            output: { summary: "Review output even when passing or skipped" },
          },
        ],
      };
    else if (path.includes("/statuses?")) result = [{ context: "Vercel CI", state: "success" }];
    else if (path.includes("/issues/1/comments?"))
      result = Array.from({ length: this.commentCount }, (_, i) => ({
        id: i + 1,
        body: i === 0 ? this.comment : "Routine conversation",
        html_url: `https://github.com/fixture/comment/${i}`,
      }));
    else if (path.includes("/pulls/1/reviews?"))
      result = [
        {
          id: 2,
          state: "COMMENTED",
          body: this.reviewBody,
          submitted_at: "2026-11-12T00:00:00Z",
        },
      ];
    else if (path.includes("/pulls/1/comments?"))
      result = [{ id: 3, body: "Inline finding", html_url: "https://github.com/fixture/inline" }];
    else if (path.includes("/pulls/1/files?"))
      result = [
        {
          filename: "agent/tool.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          patch: "@@ -1 +1 @@\n-old\n+fixed",
        },
      ];
    else if (path.includes("/git/trees/"))
      result = {
        tree: [{ path: "agent/tool.ts", mode: "100644", sha: "blob", type: "blob" }],
        truncated: false,
      };
    else if (path.includes("/git/ref/heads/")) result = { object: { sha: BASE } };
    else if (path.endsWith("/merge")) result = { merged: true, sha: MERGED };
    else if (path.includes("/commits/")) result = { commit: { verification: { verified: true } } };
    else if (path.endsWith("/pulls/1"))
      result = {
        state: "open",
        draft: false,
        head: { sha: this.head, ref: candidate().branch, repo: { full_name: "fixture/agent" } },
        base: { sha: BASE, ref: "main" },
      };
    else throw new Error(`Unexpected fixture request: ${path}`);
    return result;
  }
  override async graphql<T = any>(query: string): Promise<T> {
    if (query.includes("reviewThreads"))
      return {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  id: "thread",
                  isResolved: !this.unresolved,
                  isOutdated: false,
                  comments: { nodes: [{ body: this.threadBody, ...this.threadAuthor }] },
                },
              ],
              pageInfo: { hasNextPage: false },
            },
          },
        },
      } as T;
    return {
      repository: {
        pullRequest: {
          headRefOid: this.head,
          isDraft: false,
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          reviewDecision: this.decision,
        },
      },
    } as T;
  }
}
const configured = () =>
  config({ policy: { requiredChecks: ["Vercel CI", "Vercel Agent Review"] } });
test("passing/skipped reviews still read conversation, submitted, inline, unresolved and check diagnostics", async () => {
  const c = configured(),
    git = new FixtureGit(c);
  git.checkConclusion = "skipped";
  git.unresolved = true;
  const result = await inspectCandidate(c, candidate(), git);
  assert.ok(result.feedback.comments.some((c) => c.body === "Inline finding"));
  assert.equal(result.feedback.reviews[0].body, "Submitted review");
  assert.ok(result.outputs.some((o) => o.text.includes("Inline setup diagnostic")));
  assert.ok(
    result.outputs.some((o) => o.name === "actual candidate diff" && o.text.includes("+fixed")),
  );
  assert.equal(
    result.checks.find((check) => check.name === "Vercel Agent Review")!.status,
    "failed",
  );
  assert.equal(
    result.checks.find((check) => check.name === "resolved conversations")!.status,
    "pending",
  );
});
test("stale heads and unresolved review policy cannot reach the merge API", async () => {
  const c = configured(),
    git = new FixtureGit(c);
  const reviewed = reviewFingerprint(candidate(), await inspectCandidate(c, candidate(), git));
  git.head = "d".repeat(40);
  await assert.rejects(mergeExact(c, candidate(), reviewed, git), /identity\/head/);
  git.head = HEAD;
  git.unresolved = true;
  await assert.rejects(mergeExact(c, candidate(), reviewed, git), /block merge/);
  git.unresolved = false;
  git.decision = "REVIEW_REQUIRED";
  await assert.rejects(mergeExact(c, candidate(), reviewed, git), /enforced merge policy/);
  assert.ok(!git.calls.some((call) => call.method === "PUT"));
});
test("zero required human approvals do not introduce a manual approval gate", async () => {
  const c = configured(),
    git = new FixtureGit(c);
  const reviewed = reviewFingerprint(candidate(), await inspectCandidate(c, candidate(), git));
  assert.equal(await mergeExact(c, candidate(), reviewed, git), MERGED);
  assert.equal(git.calls.find((call) => call.method === "PUT")!.body.sha, HEAD);
});
test("edits beyond displayed feedback change the review fingerprint while merging stays blocked", async () => {
  for (const source of ["comment", "reviewBody", "threadBody"] as const) {
    const c = configured(),
      git = new FixtureGit(c);
    git[source] = "Review evidence. ".repeat(1000);
    const reviewed = reviewFingerprint(candidate(), await inspectCandidate(c, candidate(), git));
    git[source] += "New actionable finding after baseline verification";
    assert.notEqual(
      reviewFingerprint(candidate(), await inspectCandidate(c, candidate(), git)),
      reviewed,
    );
    await assert.rejects(mergeExact(c, candidate(), reviewed, git), /block merge/);
    assert.ok(!git.calls.some((call) => call.method === "PUT"));
  }
});
test("delayed GitHub base updates reconcile the signed head before exact-head inspection", async () => {
  const c = configured(),
    nextBase = "d".repeat(40),
    requested = { expectedHead: HEAD, base: nextBase, startedAt: 1, attempts: 1 };
  class UpdatingGit extends FixtureGit {
    ref = HEAD;
    parents = [HEAD, nextBase];
    override async branch() {
      return this.ref;
    }
    override async api<T = any>(path: string, method = "GET", body?: unknown): Promise<T> {
      if (path.includes(`/commits/${MERGED}`))
        return {
          commit: { verification: { verified: true } },
          parents: this.parents.map((sha) => ({ sha })),
        } as T;
      return super.api(path, method, body);
    }
  }
  const git = new UpdatingGit(c),
    proposal = candidate();
  assert.equal(await reconcileBaseUpdate(proposal, requested, git), "waiting");
  git.ref = MERGED;
  assert.equal(
    await reconcileBaseUpdate(proposal, requested, git),
    "waiting",
    "Wait for GitHub PR metadata to catch up with the branch ref",
  );
  git.head = MERGED;
  assert.equal(await reconcileBaseUpdate(proposal, requested, git), "updated");
  assert.equal(proposal.head, MERGED);
  assert.equal(proposal.base, nextBase);
  git.parents = [BASE, nextBase];
  await assert.rejects(
    reconcileBaseUpdate(candidate(), requested, git),
    /requested signed base merge/,
  );
});
test("deployment authority never reaches candidate sandboxes or dependency hooks", async () => {
  let requested: unknown;
  const c = config({
    credentials: {
      github: async () => {
        throw new Error("No candidate credentials during release");
      },
      vercel: async () => {
        throw new Error("No sandbox API authority during release");
      },
    },
    release: {
      deploy: async (input: unknown) => {
        requested = input;
      },
    },
  });
  await createHostedRunner(c).deploy(MERGED);
  assert.deepEqual(requested, { sha: MERGED, project: c.project, repository: c.repository });
  await assert.rejects(createHostedRunner(config()).deploy(MERGED), /trusted release.deploy/);
  await assert.rejects(createHostedRunner(c).deploy("main"), /immutable merged source/);
});
test("deployment ownership, source, environment and clean origin are checked before auth", () => {
  const c = config(),
    d = {
      id: "dpl_fixture",
      url: "https://preview.vercel.app",
      sha: HEAD,
      projectId: c.project.projectId,
      teamId: c.project.teamId,
      environment: "preview" as const,
      ready: true,
    };
  assert.doesNotThrow(() => assertDeployment(c, d, HEAD, "preview"));
  for (const change of [
    { teamId: "team_other" },
    { projectId: "prj_other" },
    { sha: BASE },
    { environment: "production" },
    { url: "https://preview.vercel.app/path" },
    { url: "https://secret@preview.vercel.app" },
  ])
    assert.throws(() => assertDeployment(c, { ...d, ...change } as any, HEAD, "preview"));
});
test("dependency verification requires a clean install with an exact package manager", () => {
  assert.equal(installCommand({ packageManager: "npm@11.6.2" }), "npx --yes npm@11.6.2 ci");
  assert.match(installCommand({ packageManager: "pnpm@11.0.0" }), /--frozen-lockfile/);
  for (const manager of [undefined, "npm@latest", "npm@11.6.2;echo unsafe"])
    assert.throws(() => installCommand({ packageManager: manager }));
});
test("candidate-controlled package scripts cannot replace trusted validation commands", () => {
  const commands = validationCommands(config(), {
    scripts: { test: "tsx --test tests/*.ts", typecheck: "tsc --noEmit", build: "eve build" },
  });
  assert.ok(commands.some((command) => command.endsWith("tsx --test tests/*.ts")));
  assert.ok(!commands.some((command) => command.includes("npm run")));
});
test("truncated PR patches cannot count as inspected full diffs", () => {
  assert.equal(
    completePatch({ patch: "@@ -1 +1 @@\n-old\n+fixed", additions: 1, deletions: 1 }),
    true,
  );
  assert.equal(
    completePatch({ patch: "@@ -1 +1 @@\n-old\n+fixed", additions: 20, deletions: 1 }),
    false,
  );
  assert.equal(completePatch({ patch: "@@ -1 +1 @@\n-old\n+fixed" }), false);
});
test("checkout credential leases cannot authorize GitHub API writes and are cleared afterward", async () => {
  const policies: any[] = [],
    commands: string[] = [];
  const sandbox: any = {
    async setNetworkPolicy(policy: any) {
      policies.push(policy);
    },
    async run({ command }: any) {
      commands.push(command);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  await checkout(config(), sandbox, HEAD);
  const rule = policies[0].allow["github.com"][0];
  assert.deepEqual(rule.match.method, ["GET", "POST"]);
  assert.ok(new RegExp(rule.match.path.regex).test("/fixture/agent.git/git-upload-pack"));
  assert.ok(!new RegExp(rule.match.path.regex).test("/repos/fixture/agent/git/refs"));
  assert.ok(!("api.github.com" in policies[0].allow));
  assert.equal(policies.at(-1), "allow-all");
  assert.ok(!commands.join("\n").includes("fixture-token"));
  assert.ok(commands.join("\n").includes("--depth=2"));
});

test("automatic thread resolution requires the root comment to belong to the current bot", async () => {
  const git = new FixtureGit(config());
  for (const [author, allowed] of [
    [{ viewerDidAuthor: true, author: { __typename: "Bot" } }, true],
    [{ viewerDidAuthor: true, author: { __typename: "User" } }, false],
    [{ viewerDidAuthor: false, author: { __typename: "Bot" } }, false],
    [{}, false],
  ] as const) {
    git.threadAuthor = author;
    const feedback = await git.feedback(candidate());
    assert.equal(feedback.threads[0].canAutoResolve, allowed);
  }
});

test("omitted or truncated warnings cannot authorize an exact-head merge", async () => {
  for (const source of ["comment-count", "comment", "reviewBody", "threadBody"] as const) {
    const c = configured(),
      git = new FixtureGit(c);
    if (source === "comment-count") {
      git.commentCount = 51;
      git.comment = "Security warning in the first comment";
    } else git[source] = "Security warning. ".repeat(1000);
    const inspection = await inspectCandidate(c, candidate(), git);
    assert.equal(
      inspection.checks.find((check) => check.name === "complete review evidence")?.status,
      "unavailable",
    );
    const reviewed = reviewFingerprint(candidate(), inspection);
    await assert.rejects(mergeExact(c, candidate(), reviewed, git), /block merge/);
    assert.ok(!git.calls.some((call) => call.method === "PUT"));
  }
});

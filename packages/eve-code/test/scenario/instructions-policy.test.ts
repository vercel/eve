import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const content = readFileSync(new URL("../../extension/instructions.md", import.meta.url), "utf8");
const worker = readFileSync(
  new URL("../../extension/subagents/worker/instructions.md", import.meta.url),
  "utf8",
);
const workerAgent = readFileSync(
  new URL("../../extension/subagents/worker/agent.ts", import.meta.url),
  "utf8",
);

test("routes authenticated GitHub operations through the scoped gh tool", () => {
  assert.match(content, /GitHub credentials are not available to ordinary `bash`/u);
  assert.match(content, /Use the `gh` tool for every authenticated GitHub operation/u);
  assert.match(
    content,
    /Authenticated commands run without an approval prompt[\s\S]*`description`/u,
  );
  assert.match(content, /The full `gh` CLI surface is available/u);
  assert.match(content, /Connect mints the real token for only the declared repository/u);
  assert.match(content, /sandbox process receives only a placeholder `GH_TOKEN`/u);
  assert.match(content, /GitHub rejects access outside the token's server-side repository scope/u);
  assert.match(content, /Do not use environment assignments, pipes, redirects, substitutions/u);
  assert.match(content, /Commands without an explicit repository may use normal `gh` context/u);
  assert.match(content, /Clone with `gh repo clone owner\/name`/u);
  assert.match(content, /`git push`[\s\S]*through the `gh` tool/u);
  assert.match(content, /Local `git status`[\s\S]*`rebase` remain ordinary `bash` commands/u);
});

test("keeps read-only requests from authorizing edits or publication", () => {
  assert.match(content, /Match action to the request/u);
  assert.match(content, /answer, explanation, review, status report, diagnosis, or plan/u);
  assert.match(content, /not workspace edits, publication, cross-posts, or other external writes/u);
  assert.match(content, /Diagnose and explain causes without implementing a fix unless asked/u);
  assert.match(content, /Build or change the workspace only when the requester asks/u);
  assert.match(content, /Persistence never expands authority/u);
});

test("rebases only for explicit intent or a requested delivery need", () => {
  assert.match(content, /Do not rebase before work by default/u);
  assert.match(content, /requester explicitly asks for it/u);
  assert.match(
    content,
    /explicitly requested publication or delivery outcome requires a current base/u,
  );
  assert.doesNotMatch(content, /Always rebase from current base ref/u);
});

test("names the other minds the agent must hold", () => {
  assert.match(content, /Hold the other people in the work/u);
  assert.match(content, /The requester named an outcome, not a procedure/u);
  assert.match(content, /A future maintainer pays for every new concept/u);
  assert.match(content, /A worker is another mind with one slice/u);
  assert.match(content, /Evidence does not care what you hoped/u);
});

test("prefers action over ceremony", () => {
  assert.match(content, /Prefer action over ceremony/u);
});

test("skips todo model turns for bounded tasks", () => {
  assert.match(content, /For bounded tasks, do not call `todo`/u);
  assert.match(content, /begin the work directly instead of spending a model turn/u);
  assert.match(content, /only for long-running or open-ended work/u);
});

test("parallelizes independent calls and serializes dependent work", () => {
  assert.match(content, /multiple read-only calls are independently useful/u);
  assert.match(content, /emit them in the same response/u);
  assert.match(content, /eve executes calls from one response concurrently/u);
  assert.match(content, /unless it determines whether the next call is valid/u);
  assert.match(content, /[Ii]dentify independent slices a worker can own/u);
  assert.match(content, /start independent calls together/u);
  assert.match(content, /[Ss]erialize work that depends on earlier results/u);
});

test("keeps shared workspace writes and coordination with the root agent", () => {
  assert.match(
    content,
    /Writes stay here so workers never compete to mutate the shared workspace/u,
  );
});

test("gives worker subagents bounded scope without wasteful fanout", () => {
  assert.match(content, /Work streams that can run apart should/u);
  assert.match(content, /repositories, paths or refs, constraints, and expected output/u);
  assert.match(content, /do not copy full source/u);
  assert.match(content, /do not make delegation lossy/u);
});

test("discovers and independently scopes every repository needed for the task", () => {
  assert.match(
    content,
    /Determine the repositories needed[\s\S]*source discovery and investigation/u,
  );
  assert.match(content, /even when the requester does not name them/u);
  assert.match(
    content,
    /Do not ask the requester to enumerate repositories that can be discovered/u,
  );
  assert.match(content, /may select additional repositories as the work reveals them/u);
  assert.match(content, /mints a credential lease for that repository at the moment it is needed/u);
  assert.match(content, /cross-repository work uses separate scoped commands and leases/u);
});

test("lets the caller choose durable slice ownership or an ephemeral one-shot", () => {
  assert.match(content, /Choose the lifetime/u);
  assert.match(content, /own the slice end to end/u);
  assert.match(content, /send follow-ups as deltas/u);
  assert.match(content, /spawn ephemerally/u);
});

test("worker owns a scoped slice end to end or completes it ephemerally", () => {
  assert.match(worker, /assigned mind for one scoped slice/u);
  assert.match(worker, /own that slice end to end/u);
  assert.match(worker, /answer once and stop/u);
  assert.match(worker, /Follow the\s+assignment/u);
  assert.match(worker, /not a survey for the caller to finish/u);
  assert.match(worker, /Evidence does not care what you hoped/u);
  assert.doesNotMatch(worker, /token-intensive read-only/u);
});

test("worker description tells the caller what this mind is for", () => {
  assert.match(workerAgent, /Another mind for one scoped slice/u);
  assert.match(workerAgent, /choose the lifetime/u);
  assert.match(workerAgent, /own the slice end to end/u);
  assert.match(workerAgent, /or ask once/u);
  assert.match(workerAgent, /can see the shared tree/u);
  assert.match(workerAgent, /You remain the arbiter and keep the writes/u);
  assert.doesNotMatch(workerAgent, /token-intensive read-only/u);
});

test("leads with the answer and asks only when the next cut is blocked", () => {
  assert.match(content, /The reader did not see your tool calls/u);
  assert.match(content, /Lead with the answer/u);
  assert.match(content, /The final message stands alone/u);
  assert.match(content, /If the next cut depends on an unstated constraint, ask one question/u);
  assert.match(content, /Otherwise decide and proceed/u);
});

test("prefers grep for sandbox search and apply_patch for authored edits", () => {
  assert.match(content, /Use apply_patch for authored edits/u);
  assert.match(content, /If a hunk misses, re-read that file and rewrite only the failed hunk/u);
  assert.match(content, /Use `grep` for sandbox content search/u);
  assert.match(content, /Start with `files_with_matches`/u);
});

test("reads repository-local instructions before planning or editing", () => {
  assert.match(content, /Immediately after entering a checkout and before planning or editing/u);
  assert.match(content, /read its root `AGENTS.md`/u);
  assert.match(content, /use root `CLAUDE.md` only when `AGENTS.md` is absent/u);
  assert.match(content, /Before touching any path, read the nearest nested `AGENTS.md`/u);
  assert.match(content, /falling back to `CLAUDE.md` only when that directory has no `AGENTS.md`/u);
});

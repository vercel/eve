import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { classifyTitle, parseSummary } from "./changeset-format.mjs";
import formatter from "../.changeset/changelog.mjs";

test("changeset summaries preserve details and credit only thanked handles", () => {
  assert.deepEqual(
    parseSummary(
      "Clarify the setup.\n\nUpgrade @ai-sdk/provider and visit https://example.com/@user/page.\n\nThanks @Alice and @Bob for `@vercel/blob` and @ai-sdk/provider.",
      "doc",
    ),
    {
      summary: "Clarify the setup.",
      details:
        "Upgrade @ai-sdk/provider and visit https://example.com/@user/page.\n\nThanks @Alice and @Bob for `@vercel/blob` and @ai-sdk/provider.",
      contributors: ["Alice", "Bob"],
    },
  );
  for (const text of ["Missing punctuation", "First sentence. Second sentence."]) {
    assert.throws(() => parseSummary(text, "bad"), /Changeset bad:/u);
  }
  for (const [title, category] of [
    ["feat(eve): Add a tool", "feature"],
    ["fix: Repair a tool", "bugfix"],
    ["[7/7] fix(eve): Repair a tool", "bugfix"],
    ["perf(eve): Speed up a tool", "feature"],
    ["docs(feature): Add a guide", "feature"],
    ["docs(bugfix): Correct a guide", "bugfix"],
    ["chore: Update tooling", "internal"],
  ]) {
    assert.equal(classifyTitle(title), category);
  }
  assert.throws(() => classifyTitle("docs: Update the guide"), /Invalid release PR title/u);
});

test("proposed PR titles can be validated locally without GitHub", () => {
  execFileSync(process.execPath, ["scripts/check-release-pr-title.mjs", "feat(eve): Add a tool"]);
  assert.throws(
    () =>
      execFileSync(process.execPath, ["scripts/check-release-pr-title.mjs", "Update the guide"], {
        stdio: "pipe",
      }),
    /Command failed/u,
  );
});

test("the Changesets formatter produces readable Markdown without encoded metadata", async (t) => {
  const originalCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "eve-formatter-test-"));
  t.after(async () => {
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  });
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, stdio: "pipe" }).toString().trim();
  git("init", "-q");
  git("config", "user.name", "Test Author");
  git("config", "user.email", "test@example.com");
  git("config", "commit.gpgsign", "false");
  await writeFile(join(root, "change.txt"), "change\n");
  git("add", "change.txt");
  git("commit", "-qm", "fix: Add a tool");
  const commit = git("rev-parse", "HEAD");
  process.chdir(root);
  const oldToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "fixture";
  t.after(() => {
    if (oldToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = oldToken;
  });
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        JSON.stringify([
          {
            number: 10,
            title: "Edited title without a category",
            user: { login: "Alice" },
            merged_at: "2026-01-01",
            base: { ref: "main" },
          },
        ]),
      ),
  );
  const line = await formatter.getReleaseLine({ id: "example", summary: "Add a tool.", commit });
  assert.match(
    line,
    /#### 🐛 Bug Fixes\n\n- Add a tool\. \[#10\]\(https:\/\/github\.com\/vercel\/eve\/pull\/10\)/u,
  );
  assert.match(line, /#### Contributors\n\n- \[@Alice\]\(https:\/\/github\.com\/Alice\)/u);
  assert.doesNotMatch(line, /<!--/u);
});

test("version-packages assembles changesets across bump types and preserves old releases", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "eve-release-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = (path, data) => writeFile(join(root, path), data);
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, stdio: "pipe" }).toString().trim();
  await mkdir(join(root, ".changeset"));
  await mkdir(join(root, "scripts"));
  await mkdir(join(root, "packages/eve"), { recursive: true });
  await mkdir(join(root, "packages/agent-runs"), { recursive: true });
  await symlink(resolve("node_modules"), join(root, "node_modules"), "dir");
  for (const path of [
    ".changeset/config.json",
    ".changeset/changelog.mjs",
    "scripts/changeset-format.mjs",
    "scripts/changeset-github.mjs",
    "scripts/check-release-pr-title.mjs",
    "scripts/version-packages.mjs",
  ]) {
    await copyFile(path, join(root, path));
  }
  await write(
    "package.json",
    JSON.stringify({
      name: "release-fixture",
      private: true,
      type: "module",
      packageManager: "pnpm@12.14.0",
    }),
  );
  await write("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  await write("packages/eve/package.json", JSON.stringify({ name: "eve", version: "1.0.0" }));
  await write("packages/eve/CHANGELOG.md", "# eve\n\n## 1.0.0\n\nOld release.\n");
  await write(
    "packages/agent-runs/package.json",
    JSON.stringify({ name: "@vercel/agent-runs", version: "1.0.0" }),
  );
  await write(
    "packages/agent-runs/CHANGELOG.md",
    "# @vercel/agent-runs\n\n## 1.0.0\n\nOld release.\n",
  );
  git("init", "-q");
  git("config", "user.name", "Test Author");
  git("config", "user.email", "test@example.com");
  git("config", "commit.gpgsign", "false");
  git("add", ".");
  git("commit", "-qm", "Initial fixture");
  git("tag", "eve@1.0.0");
  git("tag", "@vercel/agent-runs@1.0.0");
  const base = git("rev-parse", "HEAD");
  execFileSync(process.execPath, ["scripts/check-release-pr-title.mjs"], {
    cwd: root,
    stdio: "pipe",
    env: { ...process.env, PR_BASE_SHA: base, PR_TITLE: "No changeset" },
  });
  await write(
    ".changeset/a.md",
    '---\n"eve": minor\n---\n\nAdd a new tool.\n\nMigrate old callers to the new tool.\n\nThanks @Alice.\n',
  );
  await write(
    ".changeset/d.md",
    '---\n"eve": patch\n"@vercel/agent-runs": patch\n---\n\nImprove the new tool.\n',
  );
  git("add", ".changeset/a.md", ".changeset/d.md");
  git(
    "commit",
    "-qm",
    "feat: Add a tool\n\nCo-authored-by: Bob <123+Bob@users.noreply.github.com>\nCo-authored-by: Carol <Carol@users.noreply.github.com>",
  );
  const first = git("rev-parse", "HEAD");
  await write(".changeset/b.md", '---\n"eve": patch\n---\n\nCorrect the setup guide.\n');
  await write(".changeset/c.md", '---\n"eve": patch\n---\n\nUpdate the release tooling.\n');
  git("add", ".changeset/b.md");
  git("commit", "-qm", "docs(bugfix): Correct the guide");
  const second = git("rev-parse", "HEAD");
  git("add", ".changeset/c.md");
  git("commit", "-qm", "chore: Update tooling");
  await write(".changeset/e.md", '---\n"eve": patch\n---\n\nKeep the legacy change visible.\n');
  git("add", ".changeset/e.md");
  git("commit", "-qm", "Legacy change");
  await write(
    "mock-github.mjs",
    `globalThis.fetch = async (url) => new Response(JSON.stringify([{number: url.includes(${JSON.stringify(first)}) ? 10 : url.includes(${JSON.stringify(second)}) ? 11 : 12, title: "Edited title", user: {login: "Author"}, merged_at: "2026-01-01", base: {ref: "main"}}]), {status: 200});`,
  );
  assert.throws(() =>
    execFileSync(process.execPath, ["scripts/check-release-pr-title.mjs"], {
      cwd: root,
      stdio: "pipe",
      env: { ...process.env, PR_BASE_SHA: base, PR_TITLE: "Update docs" },
    }),
  );
  execFileSync(process.execPath, ["scripts/check-release-pr-title.mjs"], {
    cwd: root,
    stdio: "pipe",
    env: { ...process.env, PR_BASE_SHA: base, PR_TITLE: "docs(bugfix): Update docs" },
  });
  const envWithoutToken = { ...process.env, GITHUB_TOKEN: "", GH_TOKEN: "" };
  assert.throws(() =>
    execFileSync(process.execPath, ["scripts/version-packages.mjs"], {
      cwd: root,
      stdio: "pipe",
      env: envWithoutToken,
    }),
  );
  assert.equal(
    JSON.parse(await readFile(join(root, "packages/eve/package.json"), "utf8")).version,
    "1.0.0",
  );
  assert.match(await readFile(join(root, ".changeset/a.md"), "utf8"), /Add a new tool\./u);
  execFileSync(process.execPath, ["scripts/version-packages.mjs"], {
    cwd: root,
    stdio: "pipe",
    env: {
      ...process.env,
      GITHUB_TOKEN: "fixture",
      NODE_OPTIONS: `--import=${join(root, "mock-github.mjs")}`,
    },
  });
  const changelog = await readFile(join(root, "packages/eve/CHANGELOG.md"), "utf8");
  assert.match(changelog, /## 1\.1\.0\n\n### Release eve@1\.1\.0 \| \d{4}-\d\d-\d\d \| minor/u);
  const agentRunsChangelog = await readFile(join(root, "packages/agent-runs/CHANGELOG.md"), "utf8");
  assert.match(
    agentRunsChangelog,
    /## 1\.0\.1\n\n### Release @vercel\/agent-runs@1\.0\.1 \| \d{4}-\d\d-\d\d \| patch/u,
  );
  assert.match(
    changelog,
    /### 🚀 Features\n\n- Add a new tool\. \[#10\]\(https:\/\/github\.com\/vercel\/eve\/pull\/10\)/u,
  );
  assert.match(changelog, /- Improve the new tool\. \[#10\]/u);
  assert.equal([...changelog.matchAll(/^### 🚀 Features$/gmu)].length, 1);
  assert.match(changelog, /### 🐛 Bug Fixes\n\n- Correct the setup guide\. \[#11\]/u);
  assert.match(
    changelog,
    /### Other Changes\n\nSee the \[full list of changes\]\(https:\/\/github\.com\/vercel\/eve\/compare\/eve%401\.0\.0\.\.\.eve%401\.1\.0\)\./u,
  );
  assert.match(
    agentRunsChangelog,
    /### Other Changes\n\nSee the \[full list of changes\]\(https:\/\/github\.com\/vercel\/eve\/compare\/%40vercel%2Fagent-runs%401\.0\.0\.\.\.%40vercel%2Fagent-runs%401\.0\.1\)\./u,
  );
  assert.doesNotMatch(changelog, /Keep the legacy change visible/u);
  assert.match(changelog, /\[@Alice\]\(https:\/\/github\.com\/Alice\)/u);
  assert.match(changelog, /\[@Bob\]\(https:\/\/github\.com\/Bob\)/u);
  assert.match(changelog, /\[@Carol\]\(https:\/\/github\.com\/Carol\)/u);
  assert.match(changelog, /\n\n  Migrate old callers to the new tool\./u);
  assert.doesNotMatch(changelog, /Update the release tooling|eve-changeset:/u);
  assert.match(changelog, /## 1\.0\.0\n\nOld release\./u);
  await write(
    "packages/eve/CHANGELOG.md",
    "# eve\n\n## 1.1.0\n\n### Minor Changes\n\n#### 🐛 Bug Fixes\n\n- Recover the release. [#10](https://github.com/vercel/eve/pull/10)\n\n## 1.0.0\n\nOld release.\n",
  );
  execFileSync(process.execPath, ["scripts/version-packages.mjs"], {
    cwd: root,
    stdio: "pipe",
    env: envWithoutToken,
  });
  assert.match(
    await readFile(join(root, "packages/eve/CHANGELOG.md"), "utf8"),
    /### 🐛 Bug Fixes\n\n- Recover the release\./u,
  );
  assert.match(
    await readFile(join(root, "packages/eve/CHANGELOG.md"), "utf8"),
    /compare\/eve%401\.0\.0\.\.\.eve%401\.1\.0/u,
  );
  git("tag", "-d", "@vercel/agent-runs@1.0.0");
  await write(
    "packages/agent-runs/CHANGELOG.md",
    "# @vercel/agent-runs\n\n## 1.0.1\n\n### Patch Changes\n\n#### 🚀 Features\n\n- Recover a release. [#10](https://github.com/vercel/eve/pull/10)\n",
  );
  execFileSync(process.execPath, ["scripts/version-packages.mjs"], {
    cwd: root,
    stdio: "pipe",
    env: envWithoutToken,
  });
  assert.match(
    await readFile(join(root, "packages/agent-runs/CHANGELOG.md"), "utf8"),
    /commits\/%40vercel%2Fagent-runs%401\.0\.1/u,
  );
});

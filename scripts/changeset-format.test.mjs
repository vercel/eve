import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { parseSummary } from "./changeset-format.mjs";

test("changeset summaries require a category and one sentence", () => {
  assert.deepEqual(parseSummary("docs(bugfix): Clarify the setup.\n\nThanks @Alice.", "doc"), {
    category: "bugfix",
    summary: "Clarify the setup.",
    contributors: ["Alice"],
  });
  for (const text of [
    "A summary.",
    "feature: Missing punctuation",
    "feature: First sentence. Second sentence.",
    "docs: Updated docs.",
  ]) {
    assert.throws(() => parseSummary(text, "bad"), /Changeset bad:/u);
  }
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
  await symlink(resolve("node_modules"), join(root, "node_modules"), "dir");
  for (const path of [
    ".changeset/config.json",
    ".changeset/changelog.mjs",
    "scripts/changeset-format.mjs",
    "scripts/changeset-github.mjs",
    "scripts/check-changesets.mjs",
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
  git("init", "-q");
  git("config", "user.name", "Test Author");
  git("config", "user.email", "test@example.com");
  git("config", "commit.gpgsign", "false");
  git("add", ".");
  git("commit", "-qm", "Initial fixture");
  await write(
    ".changeset/a.md",
    '---\n"eve": minor\n---\n\nfeature: Add a new tool.\n\nThanks @Alice.\n',
  );
  git("add", ".changeset/a.md");
  git("commit", "-qm", "Add feature\n\nCo-authored-by: Bob <123+Bob@users.noreply.github.com>");
  const first = git("rev-parse", "HEAD");
  await write(
    ".changeset/b.md",
    '---\n"eve": patch\n---\n\ndocs(bugfix): Correct the setup guide.\n',
  );
  await write(
    ".changeset/c.md",
    '---\n"eve": patch\n---\n\ninternal: Update the release tooling.\n',
  );
  git("add", ".changeset/b.md", ".changeset/c.md");
  git("commit", "-qm", "Update docs");
  await write(
    "mock-github.mjs",
    `globalThis.fetch = async (url) => new Response(JSON.stringify([{number: url.includes(${JSON.stringify(first)}) ? 10 : 11, user: {login: "Author"}, merged_at: "2026-01-01", base: {ref: "main"}}]), {status: 200});`,
  );
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
  assert.match(await readFile(join(root, ".changeset/a.md"), "utf8"), /feature: Add a new tool\./u);
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
  assert.match(changelog, /## 1\.1\.0\n\n### Release 1\.1\.0 \| \d{4}-\d\d-\d\d \| minor/u);
  assert.match(
    changelog,
    /### 🚀 Features\n\n- Add a new tool\. \[#10\]\(https:\/\/github\.com\/vercel\/eve\/pull\/10\)/u,
  );
  assert.match(changelog, /### 🐛 Bug Fix\n\n- Correct the setup guide\. \[#11\]/u);
  assert.match(changelog, /\[@Alice\]\(https:\/\/github\.com\/Alice\)/u);
  assert.match(changelog, /\[@Bob\]\(https:\/\/github\.com\/Bob\)/u);
  assert.doesNotMatch(changelog, /Update the release tooling|eve-changeset:/u);
  assert.match(changelog, /## 1\.0\.0\n\nOld release\./u);
});

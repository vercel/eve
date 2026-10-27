import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { classifyTitle, parseSummary } from "./changeset-format.mjs";
import formatter from "../.changeset/changelog.mjs";

test("changeset summaries are plain sentences and PR titles select the category", () => {
  assert.deepEqual(parseSummary("Clarify the setup.\n\nThanks @Alice.", "doc"), {
    summary: "Clarify the setup.",
    contributors: ["Alice"],
  });
  for (const text of ["Missing punctuation", "First sentence. Second sentence."]) {
    assert.throws(() => parseSummary(text, "bad"), /Changeset bad:/u);
  }
  for (const [title, category] of [
    ["feat(eve): Add a tool", "feature"],
    ["fix: Repair a tool", "bugfix"],
    ["docs(feature): Add a guide", "feature"],
    ["docs(bugfix): Correct a guide", "bugfix"],
    ["chore: Update tooling", "internal"],
  ]) {
    assert.equal(classifyTitle(title), category);
  }
  assert.throws(() => classifyTitle("docs: Update the guide"), /Invalid release PR title/u);
});

test("the Changesets formatter produces readable Markdown without encoded metadata", async (t) => {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
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
            title: "feat: Add a tool",
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
    /#### 🚀 Features\n\n- Add a tool\. \[#10\]\(https:\/\/github\.com\/vercel\/eve\/pull\/10\)/u,
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
  await symlink(resolve("node_modules"), join(root, "node_modules"), "dir");
  for (const path of [
    ".changeset/config.json",
    ".changeset/changelog.mjs",
    "scripts/changeset-format.mjs",
    "scripts/changeset-github.mjs",
    "scripts/check-changesets.mjs",
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
  git("init", "-q");
  git("config", "user.name", "Test Author");
  git("config", "user.email", "test@example.com");
  git("config", "commit.gpgsign", "false");
  git("add", ".");
  git("commit", "-qm", "Initial fixture");
  const base = git("rev-parse", "HEAD");
  execFileSync(process.execPath, ["scripts/check-release-pr-title.mjs"], {
    cwd: root,
    stdio: "pipe",
    env: { ...process.env, PR_BASE_SHA: base, PR_TITLE: "No changeset" },
  });
  await write(".changeset/a.md", '---\n"eve": minor\n---\n\nAdd a new tool.\n\nThanks @Alice.\n');
  await write(".changeset/d.md", '---\n"eve": patch\n---\n\nImprove the new tool.\n');
  git("add", ".changeset/a.md", ".changeset/d.md");
  git("commit", "-qm", "Add feature\n\nCo-authored-by: Bob <123+Bob@users.noreply.github.com>");
  const first = git("rev-parse", "HEAD");
  await write(".changeset/b.md", '---\n"eve": patch\n---\n\nCorrect the setup guide.\n');
  await write(".changeset/c.md", '---\n"eve": patch\n---\n\nUpdate the release tooling.\n');
  git("add", ".changeset/b.md");
  git("commit", "-qm", "Update docs");
  const second = git("rev-parse", "HEAD");
  git("add", ".changeset/c.md");
  git("commit", "-qm", "Update tooling");
  await write(
    "mock-github.mjs",
    `globalThis.fetch = async (url) => new Response(JSON.stringify([{number: url.includes(${JSON.stringify(first)}) ? 10 : url.includes(${JSON.stringify(second)}) ? 11 : 12, title: url.includes(${JSON.stringify(first)}) ? "feat: Add a tool" : url.includes(${JSON.stringify(second)}) ? "docs(bugfix): Correct the guide" : "chore: Update tooling", user: {login: "Author"}, merged_at: "2026-01-01", base: {ref: "main"}}]), {status: 200});`,
  );
  await write(
    "mock-invalid-github.mjs",
    `globalThis.fetch = async () => new Response(JSON.stringify([{number: 10, title: "Update the tool", user: {login: "Author"}, merged_at: "2026-01-01", base: {ref: "main"}}]));`,
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
  assert.throws(() =>
    execFileSync(process.execPath, ["scripts/version-packages.mjs"], {
      cwd: root,
      stdio: "pipe",
      env: {
        ...process.env,
        GITHUB_TOKEN: "fixture",
        NODE_OPTIONS: `--import=${join(root, "mock-invalid-github.mjs")}`,
      },
    }),
  );
  assert.equal(
    JSON.parse(await readFile(join(root, "packages/eve/package.json"), "utf8")).version,
    "1.0.0",
  );
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
  assert.match(changelog, /- Improve the new tool\. \[#10\]/u);
  assert.equal([...changelog.matchAll(/^### 🚀 Features$/gmu)].length, 1);
  assert.match(changelog, /### 🐛 Bug Fix\n\n- Correct the setup guide\. \[#11\]/u);
  assert.match(changelog, /\[@Alice\]\(https:\/\/github\.com\/Alice\)/u);
  assert.match(changelog, /\[@Bob\]\(https:\/\/github\.com\/Bob\)/u);
  assert.doesNotMatch(changelog, /Update the release tooling|eve-changeset:/u);
  assert.match(changelog, /## 1\.0\.0\n\nOld release\./u);
});

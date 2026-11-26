import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  contextBarItems,
  parseCheckout,
  pullRequestFromCall,
  READ_CHECKOUT,
  repositoryHints,
} from "../../extension/lib/code-channel.ts";

test("takes the repository from the settled call", () => {
  assert.deepEqual(
    repositoryHints({ name: "edit_file", input: { path: "/w/app/src/a.ts" }, output: null }),
    ["/w/app/src/a.ts"],
  );
  assert.deepEqual(
    repositoryHints({ name: "write_file", input: { filePath: "app/b.ts" }, output: null }),
    ["app/b.ts"],
  );
  assert.deepEqual(
    repositoryHints({
      name: "git__gh",
      input: { command: "gh repo clone acme/app", workingDirectory: "/w" },
      output: null,
    }),
    ["/w", "app"],
  );
  assert.deepEqual(
    repositoryHints({
      name: "bash",
      input: { command: "cd /w/app && git -C '/w/lib' status" },
      output: null,
    }),
    ["/w/app", "/w/lib"],
  );
});

test("reads the pull request a `gh pr create` printed", () => {
  const observed = {
    name: "git__gh",
    input: { command: "gh pr create --draft --title Fix" },
    output: { stdout: "https://github.com/acme/app/pull/42\n" },
  };
  assert.deepEqual(pullRequestFromCall(observed), {
    url: "https://github.com/acme/app/pull/42",
    number: 42,
  });
  assert.equal(
    pullRequestFromCall({ ...observed, input: { command: "gh pr view 42" } }),
    undefined,
  );
});

test("links the branch only once it is pushed", () => {
  const repository = {
    root: "/w/app",
    slug: "acme/app",
    branch: "fix/login",
    base: "main",
    pushed: false,
    changedFiles: 1,
  };
  assert.deepEqual(
    contextBarItems(repository, { url: "https://github.com/acme/app/pull/42", number: 42 }),
    [
      { key: "repo", label: "acme/app", icon: "folder", url: "https://github.com/acme/app" },
      { key: "branch", label: "fix/login", icon: "branch" },
      { key: "changes", label: "1 file changed", icon: "code" },
      { key: "pr", label: "PR #42", icon: "hierarchy", url: "https://github.com/acme/app/pull/42" },
    ],
  );
  assert.equal(
    contextBarItems({ ...repository, pushed: true }, undefined)[1]?.url,
    "https://github.com/acme/app/tree/fix/login",
  );
});

test("diffs a checkout against its base without secrets or remote credentials", () => {
  const root = mkdtempSync(join(tmpdir(), "code-channel-"));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd,
      stdio: "pipe",
    });
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, work);
  writeFileSync(join(work, "a.ts"), "one\n");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "init");
  git(work, "push", "-q", "origin", "main");
  git(work, "remote", "set-head", "origin", "main");
  git(work, "remote", "set-url", "origin", "https://x-token:secret@github.com/acme/app.git");
  git(work, "checkout", "-q", "-b", "fix");
  writeFileSync(join(work, "a.ts"), "two\n");
  writeFileSync(join(work, "new.ts"), "new\n");
  writeFileSync(join(work, ".env"), "TOKEN=secret\n");

  const stdout = execFileSync("sh", ["-c", READ_CHECKOUT, "sh", join(work, "a.ts")], {
    cwd: root,
    encoding: "utf8",
  });
  const checkout = parseCheckout(stdout);
  assert.equal(checkout?.slug, "acme/app");
  assert.equal(checkout?.branch, "fix");
  assert.equal(checkout?.base, "main");
  assert.equal(checkout?.pushed, false);
  assert.equal(checkout?.changedFiles, 3);
  assert.match(checkout?.diff ?? "", /^\+two$/mu);
  assert.match(checkout?.diff ?? "", /^\+new$/mu);
  assert.doesNotMatch(stdout, /secret/u);
});

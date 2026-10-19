import assert from "node:assert/strict";
import test from "node:test";

import { attributeCommand, coAuthorTrailer, withTrailer } from "../../extension/lib/attribution.ts";

const TRAILER = "Co-authored-by: octocat <1+octocat@users.noreply.github.com>";

function files(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async readTextFile({ path }: { path: string }) {
      return store.get(path) ?? null;
    },
    async writeTextFile({ content, path }: { content: string; path: string }) {
      store.set(path, content);
    },
  };
}

function attribute(argv: string[], sandbox = files()) {
  return attributeCommand(argv, TRAILER, sandbox, "/workspace/repo", "/tmp/body.md");
}

test("formats a trailer and rejects values that could inject lines", () => {
  assert.equal(
    coAuthorTrailer({ name: "octocat", email: "1+octocat@users.noreply.github.com" }),
    TRAILER,
  );
  assert.throws(() => coAuthorTrailer({ name: "a\nCo-authored-by: b", email: "a@b.c" }), /name/u);
  assert.throws(() => coAuthorTrailer({ name: "a", email: "a@b.c>\nx" }), /email/u);
});

test("appends the trailer once", () => {
  assert.equal(withTrailer("", TRAILER), TRAILER);
  assert.equal(withTrailer("Fix it.\n", TRAILER), `Fix it.\n\n${TRAILER}`);
  assert.equal(withTrailer(`Fix it.\n\n${TRAILER}`, TRAILER), `Fix it.\n\n${TRAILER}`);
});

test("extends an existing trailer block so earlier co-authors still count", () => {
  const existing = "Fix it.\n\nCo-authored-by: A <a@x.y>\n";
  assert.equal(withTrailer(existing, TRAILER), `Fix it.\n\nCo-authored-by: A <a@x.y>\n${TRAILER}`);
  // A lone `Key: value` paragraph is the subject or prose, not a trailer block.
  assert.equal(withTrailer("Note: details", TRAILER), `Note: details\n\n${TRAILER}`);
  assert.equal(
    withTrailer("Fix it.\n\nSee: this is prose\nacross lines", TRAILER),
    `Fix it.\n\nSee: this is prose\nacross lines\n\n${TRAILER}`,
  );
});

test("adds the trailer to signed commit bodies", async () => {
  assert.deepEqual(await attribute(["gh-signed-commit", "--repo", "o/r", "-m", "Fix"]), [
    "gh-signed-commit",
    "--repo",
    "o/r",
    "-m",
    "Fix",
    "-b",
    TRAILER,
  ]);
  assert.deepEqual(await attribute(["gh-signed-commit", "-m", "Fix", "-b", "A", "-b", "Why."]), [
    "gh-signed-commit",
    "-m",
    "Fix",
    "-b",
    "A",
    "-b",
    `Why.\n\n${TRAILER}`,
  ]);
});

test("adds the trailer to pull request bodies without touching the model's file", async () => {
  assert.deepEqual(await attribute(["gh", "pr", "create", "--body=Why."]), [
    "gh",
    "pr",
    "create",
    `--body=Why.\n\n${TRAILER}`,
  ]);
  assert.deepEqual(await attribute(["gh", "pr", "create", "-bWhy."]), [
    "gh",
    "pr",
    "create",
    `-b=Why.\n\n${TRAILER}`,
  ]);
  assert.deepEqual(await attribute(["gh", "pr", "create", "-b=Why."]), [
    "gh",
    "pr",
    "create",
    `-b=Why.\n\n${TRAILER}`,
  ]);
  const sandbox = files({ "/workspace/repo/pr.md": "Why.\n" });
  assert.deepEqual(await attribute(["gh", "pr", "create", "--body-file", "pr.md"], sandbox), [
    "gh",
    "pr",
    "create",
    "--body-file",
    "/tmp/body.md",
  ]);
  assert.equal(sandbox.store.get("/tmp/body.md"), `Why.\n\n${TRAILER}`);
  assert.equal(sandbox.store.get("/workspace/repo/pr.md"), "Why.\n");
  assert.deepEqual(await attribute(["gh", "pr", "create", "-Fpr.md"], sandbox), [
    "gh",
    "pr",
    "create",
    "-F=/tmp/body.md",
  ]);
});

test("leaves other commands unchanged", async () => {
  for (const argv of [
    ["gh", "pr", "comment", "1", "--body", "hi"],
    ["gh", "pr", "create", "--fill"],
    ["gh", "pr", "create", "--template", "bug.md"],
    ["git", "push", "origin", "HEAD"],
  ]) {
    assert.deepEqual(await attribute(argv), argv);
  }
});

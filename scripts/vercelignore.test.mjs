import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const vercelignore = new URL("../.vercelignore", import.meta.url);

// Vercel deletes the files under an ignored `.git` but keeps the folder. Turbo 2.11.11 then
// treats the checkout as a git repo, and `git ls-files` exits 128 when task outputs already exist.
test("root .vercelignore does not ignore .git", () => {
  const ignored = readFileSync(vercelignore, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .filter((line) => ["/.git", ".git", "/.git/", ".git/"].includes(line));
  assert.deepEqual(ignored, []);
});

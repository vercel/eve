import { execFileSync } from "node:child_process";
import { classifyTitle } from "./changeset-format.mjs";

let base = process.env.PR_BASE_SHA;
if (process.env.GITHUB_EVENT_NAME === "pull_request") {
  // The event's base SHA can be older than checkout's synthetic merge base.
  const parents = execFileSync("git", ["rev-list", "--parents", "-n", "1", "HEAD"], {
    encoding: "utf8",
  })
    .trim()
    .split(" ");
  if (parents.length !== 3)
    throw new Error("Expected GitHub's two-parent pull request merge commit.");
  base = parents[1];
}
if (!base || !/^[a-f\d]{40}$/u.test(base)) throw new Error("Missing pull request base SHA.");
const changed = execFileSync(
  "git",
  ["diff", "--name-only", "--diff-filter=AM", base, "HEAD", "--", ".changeset"],
  { encoding: "utf8" },
);
if (changed.split("\n").some((path) => /^\.changeset\/(?!README\.md$)[^/]+\.md$/u.test(path))) {
  classifyTitle(process.env.PR_TITLE ?? "");
}

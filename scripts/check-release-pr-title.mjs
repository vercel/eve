import { execFileSync } from "node:child_process";
import { classifyTitle } from "./changeset-format.mjs";

const base = process.env.PR_BASE_SHA;
if (!base || !/^[a-f\d]{40}$/u.test(base)) throw new Error("Missing or invalid PR base SHA.");
const changed = execFileSync(
  "git",
  ["diff", "--name-only", "--diff-filter=AM", base, "HEAD", "--", ".changeset"],
  { encoding: "utf8" },
);
if (changed.split("\n").some((path) => /^\.changeset\/(?!README\.md$)[^/]+\.md$/u.test(path))) {
  classifyTitle(process.env.PR_TITLE ?? "");
}

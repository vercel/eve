import { execFileSync } from "node:child_process";
import { classifyTitle } from "./changeset-format.mjs";

if (process.argv.length > 2) {
  if (process.argv.length !== 3) throw new Error('Usage: pnpm check:pr-title "feat: description"');
  classifyTitle(process.argv[2]);
  process.stdout.write("[eve:check:pr-title] ok — title matches a release category.\n");
} else {
  const base = process.env.PR_BASE_SHA;
  if (!base || !/^[a-f\d]{40}$/u.test(base)) {
    throw new Error('Pass a title: pnpm check:pr-title "feat: description"');
  }
  const changed = execFileSync(
    "git",
    ["diff", "--name-only", "--diff-filter=AM", base, "HEAD", "--", ".changeset"],
    { encoding: "utf8" },
  );
  if (changed.split("\n").some((path) => /^\.changeset\/(?!README\.md$)[^/]+\.md$/u.test(path))) {
    classifyTitle(process.env.PR_TITLE ?? "");
  }
}

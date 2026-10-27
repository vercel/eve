import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { classifyTitle } from "./changeset-format.mjs";

const checked = new Set();
const remoteName = process.argv[2];
const remotes = execFileSync("git", ["remote"], { encoding: "utf8" }).trim().split("\n");
const knownRemoteRefs = remotes.includes(remoteName) ? `--remotes=${remoteName}` : "--remotes";
for (const line of readFileSync(0, "utf8").split(/\r?\n/u)) {
  if (!line) continue;
  const [, local, remoteRef, remote] = line.split(" ");
  if (!remoteRef?.startsWith("refs/heads/") || !local || /^0+$/u.test(local)) continue;
  const exclusions = [];
  if (remote && !/^0+$/u.test(remote)) {
    try {
      execFileSync("git", ["cat-file", "-e", `${remote}^{commit}`], { stdio: "ignore" });
      exclusions.push(`^${remote}`);
    } catch {
      // An unfetched remote commit cannot be excluded from local history.
    }
  }
  const commits = execFileSync(
    "git",
    ["log", "--no-merges", "--format=%H%x09%s", local, ...exclusions, "--not", knownRemoteRefs],
    { encoding: "utf8" },
  );
  for (const entry of commits.split("\n")) {
    if (!entry) continue;
    const separator = entry.indexOf("\t");
    const hash = entry.slice(0, separator);
    if (checked.has(hash)) continue;
    checked.add(hash);
    const subject = entry.slice(separator + 1);
    try {
      classifyTitle(subject);
    } catch (error) {
      process.stderr.write(`[eve:pre-push] ${hash.slice(0, 7)}: ${error.message}\n`);
      process.exitCode = 1;
    }
  }
}

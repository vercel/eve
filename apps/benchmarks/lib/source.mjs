import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function workingTreeSubject(repositoryRoot) {
  return archiveSubject(repositoryRoot, "working tree", "current", (archivePath, environment) => {
    git(repositoryRoot, ["read-tree", "HEAD"], environment);
    git(repositoryRoot, ["add", "-A"], environment);
    const tree = git(repositoryRoot, ["write-tree"], environment).trim();
    git(repositoryRoot, ["archive", "--format=tar.gz", `--output=${archivePath}`, tree]);
    return tree;
  });
}

export function revisionSubject(repositoryRoot, requestedRevision, label) {
  const revision = git(repositoryRoot, [
    "rev-parse",
    "--verify",
    `${requestedRevision}^{commit}`,
  ]).trim();
  return archiveSubject(
    repositoryRoot,
    revision.slice(0, 12),
    label,
    (archivePath) => {
      const tree = git(repositoryRoot, ["rev-parse", `${revision}^{tree}`]).trim();
      git(repositoryRoot, ["archive", "--format=tar.gz", `--output=${archivePath}`, revision]);
      return tree;
    },
    { revision },
  );
}

function archiveSubject(repositoryRoot, description, label, createArchive, details = {}) {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "eve-authoring-"));
  const archivePath = join(temporaryDirectory, "source.tar.gz");
  const indexPath = join(temporaryDirectory, "index");
  try {
    const digest = createArchive(archivePath, { ...process.env, GIT_INDEX_FILE: indexPath });
    return { label, description, archive: readFileSync(archivePath), digest, ...details };
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function git(cwd, args, env = process.env) {
  return execFileSync("git", args, { cwd, env, encoding: "utf8" });
}

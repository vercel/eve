import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    const archive = readFileSync(archivePath);
    return {
      label,
      description,
      archive,
      digest,
      dependencyArchive: dependencyArchive(archive),
      dependencyDigest: dependencyDigest(archive),
      ...details,
    };
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function dependencyDigest(archive) {
  const hash = createHash("sha256");
  for (const path of dependencyPaths(archive)) {
    const content = execFileSync("tar", ["-xOzf", "-", path], {
      input: archive,
      maxBuffer: 10 * 1024 * 1024,
    });
    hash.update(path).update("\0").update(content).update("\0");
  }
  return hash.digest("hex");
}

function dependencyArchive(archive) {
  const directory = mkdtempSync(join(tmpdir(), "eve-authoring-dependencies-"));
  const archivePath = join(directory, "dependencies.tar.gz");
  try {
    for (const path of dependencyPaths(archive)) {
      const destination = join(directory, "input", path);
      mkdirSync(join(destination, ".."), { recursive: true });
      writeFileSync(
        destination,
        execFileSync("tar", ["-xOzf", "-", path], {
          input: archive,
          maxBuffer: 10 * 1024 * 1024,
        }),
      );
    }
    execFileSync("tar", ["-czf", archivePath, "-C", join(directory, "input"), "."]);
    return readFileSync(archivePath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function dependencyPaths(archive) {
  const paths = execFileSync("tar", ["-tzf", "-"], { input: archive, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  return paths.filter(
    (path) =>
      path === ".npmrc" ||
      path === "package.json" ||
      path === "pnpm-lock.yaml" ||
      path === "pnpm-workspace.yaml" ||
      /(?:^|\/)package\.json$/u.test(path) ||
      path.startsWith("patches/"),
  );
}

function git(cwd, args, env = process.env) {
  return execFileSync("git", args, { cwd, env, encoding: "utf8" });
}

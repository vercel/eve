import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { discover } from "./migratew.mjs";

const wire = "packages/eve/src/execution/wire/";
const sessionInbox = `${wire}session-inbox/`;
const migrations = `${sessionInbox}migrations/`;
const generated = `${sessionInbox}generated/`;
const machinery = new Set([
  "packages/eve/scripts/migratew.mjs",
  "packages/eve/scripts/migratew.test.mjs",
  "packages/eve/scripts/guard-wire-changes.mjs",
  "scripts/guard-invariants.mjs",
]);

/** Version additions supply contracts and transforms; machinery changes ship separately. */
export async function checkWireChanges(repoRoot, baseRef = "origin/main") {
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  let base;
  try {
    base = git("merge-base", baseRef, "HEAD").trim();
  } catch {
    throw new Error(
      `Cannot check wire changes without a merge base with ${baseRef}. Fetch the base branch and its history, then rerun pnpm guard:invariants.`,
    );
  }
  const basePaths = new Set(
    git("ls-tree", "-r", "--name-only", "-z", base).split("\0").filter(Boolean),
  );
  const baseVersions = [...basePaths].flatMap((path) => {
    const schema = path.match(
      /^packages\/eve\/src\/execution\/wire\/(?:session-inbox\/)?session-inbox-wire\.v(\d+)\.ts$/,
    );
    const migration = path.match(
      /^packages\/eve\/src\/execution\/wire\/session-inbox\/migrations\/v\d+-to-v(\d+)\.ts$/,
    );
    return schema || migration ? [Number((schema ?? migration)[1])] : [];
  });
  const { versions } = await discover(join(repoRoot, "packages/eve"), "session-inbox");
  if (versions.at(-1) <= Math.max(0, ...baseVersions)) return;

  // Comparing the merge base to the worktree includes committed, staged, and unstaged edits.
  const changed = new Set([
    ...git("diff", "--no-renames", "--name-only", "-z", base).split("\0"),
    ...git("ls-files", "--others", "--exclude-standard", "-z").split("\0"),
  ]);
  const forbidden = [...changed].filter((path) => {
    if (
      machinery.has(path) ||
      path.startsWith("packages/eve/src/execution/durable-session-migrations/")
    )
      return true;
    if (!path.startsWith(sessionInbox) || path.startsWith(generated)) return false;
    return !(
      path.startsWith(migrations) &&
      /^v\d+(?:-to-v\d+(?:\.test)?|\.schema)\.ts$/.test(path.slice(migrations.length)) &&
      !basePaths.has(path)
    );
  });
  if (forbidden.length) {
    throw new Error(
      `A wire version addition may change only new schema/migration/test files and generated files within wire, and must leave the migration machinery unchanged. Ship machinery changes in a separate PR first. Use pnpm run migratew session-inbox to add a version. Forbidden changes:\n${forbidden.sort().join("\n")}`,
    );
  }
}

/**
 * Copies the shared writing references into every skill that carries them.
 *
 * @remarks
 * The root agent and the reviewer subagent each have a `writing-quality` skill, and a subagent
 * can't read the root's skills. The reference files both copies share word for word live once in
 * `shared-references/`; this script writes them into each skill's `references/` folder. Edit the
 * files in `shared-references/`, never the copies. Runs before `dev` and `build`; pass `--check`
 * to fail instead of writing when a copy is out of date. Paths resolve from this file's
 * location, so the script works from any working directory.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** Repository root, one level above this script's folder. */
const ROOT_DIR = fileURLToPath(new URL("..", import.meta.url));

/** Folder that holds the single source of each shared reference file. */
const SOURCE_DIR = join(ROOT_DIR, "shared-references");

/** Skill reference folders that receive a copy of every shared file. */
const TARGET_DIRS = [
  join(ROOT_DIR, "agent/skills/writing-quality/references"),
  join(ROOT_DIR, "agent/subagents/reviewer/skills/writing-quality/references"),
];

/** Whether to report out-of-date copies and exit non-zero instead of writing them. */
const checkOnly = process.argv.includes("--check");

/**
 * Read a file, or return `null` when it doesn't exist.
 *
 * @param path - The file to read.
 * @returns The file's text, or `null`.
 */
const readIfPresent = async (path) => {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
};

/**
 * Bring one target copy in line with its shared source.
 *
 * @param name - The shared file's name.
 * @param dir - The skill reference folder that holds the copy.
 * @returns The copy's path when it was out of date, otherwise `null`.
 */
const syncCopy = async (name, dir) => {
  const content = await readFile(join(SOURCE_DIR, name), "utf8");
  const target = join(dir, name);
  if ((await readIfPresent(target)) === content) {
    return null;
  }
  if (!checkOnly) {
    await writeFile(target, content);
  }
  return target;
};

const names = (await readdir(SOURCE_DIR)).filter((name) =>
  name.endsWith(".md")
);
const results = await Promise.all(
  names.flatMap((name) => TARGET_DIRS.map((dir) => syncCopy(name, dir)))
);
const stale = results.filter((target) => target !== null);

if (checkOnly && stale.length > 0) {
  process.stderr.write(
    `Out of date: ${stale.join(", ")}. Run \`pnpm sync:shared\`.\n`
  );
  process.exit(1);
}

process.stdout.write(
  stale.length > 0
    ? `Synced ${stale.length} shared reference file(s).\n`
    : "Shared references are up to date.\n"
);

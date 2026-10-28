import { readFile, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const packageRoot = resolve(process.argv[2] ?? ".");
const changelogPath = join(packageRoot, "CHANGELOG.md");
const backupPath = join(
  dirname(packageRoot),
  `.${basename(packageRoot)}.eve-changelog-backup.json`,
);
const { source, content } = JSON.parse(await readFile(backupPath, "utf8"));
if ((await readFile(changelogPath, "utf8")) !== content) {
  throw new Error(
    `The changelog changed during packing. Restore the history from ${backupPath} manually.`,
  );
}
await writeFile(changelogPath, source);
await unlink(backupPath);

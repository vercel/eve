import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseChangesetsChangelog, type ChangelogSource } from "@vercel/geistdocs/changelog";

const readChangelogEntries = async () => {
  "use cache";

  const markdown = await readFile(
    path.join(process.cwd(), "../../packages/eve/CHANGELOG.md"),
    "utf8",
  );
  return parseChangesetsChangelog(markdown);
};

export const changelogSource = {
  getEntries: (_context) => readChangelogEntries(),
} satisfies ChangelogSource;

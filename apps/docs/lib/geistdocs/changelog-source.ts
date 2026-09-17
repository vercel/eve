import { readFile } from "node:fs/promises";
import path from "node:path";
import { createChangesetsChangelogSource } from "@vercel/geistdocs/changelog";

const readChangelog = async () => {
  "use cache";

  return readFile(path.join(process.cwd(), "../../packages/eve/CHANGELOG.md"), "utf8");
};

export const changelogSource = createChangesetsChangelogSource({ read: readChangelog });

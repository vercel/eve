import { readdir, readFile } from "node:fs/promises";
import { parseSummary } from "./changeset-format.mjs";

for (const file of await readdir(".changeset")) {
  if (!file.endsWith(".md") || file === "README.md") continue;
  const content = await readFile(`.changeset/${file}`, "utf8");
  const match = /^---\r?\n([\s\S]*?)^---\r?\n([\s\S]*)$/mu.exec(content);
  if (!match) throw new Error(`Changeset ${file}: invalid frontmatter.`);
  if (match[1].trim()) parseSummary(match[2], file);
}

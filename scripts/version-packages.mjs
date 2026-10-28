import { execFileSync } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getPackages } from "@manypkg/get-packages";

function renderRelease({ name, version, date, bump, body, changesUrl }) {
  const sections = [`### Release ${name}@${version} | ${date} | ${bump}`];
  const groups = new Map();
  const headings = [...body.matchAll(/^#{3,4} (.+)$/gmu)];
  for (let i = 0; i < headings.length; i++) {
    const match = headings[i];
    if (!match[0].startsWith("#### ")) continue;
    const block = body.slice(match.index + match[0].length, headings[i + 1]?.index).trim();
    const group = groups.get(match[1]) ?? [];
    if (block) group.push(block);
    groups.set(match[1], group);
  }
  for (const title of [
    "🚀 Features",
    "🐛 Bug Fixes",
    "Other Changes",
    "Dependencies",
    "Contributors",
  ]) {
    if (title === "Other Changes") {
      sections.push(`### Other Changes\n\nSee the [full list of changes](${changesUrl}).`);
      continue;
    }
    let lines = groups.get(title) ?? [];
    if (title === "Contributors") {
      lines = lines.flatMap((block) => block.split("\n"));
      lines = [...new Map(lines.map((line) => [line.toLowerCase(), line])).values()].sort((a, b) =>
        a.localeCompare(b, "en", { sensitivity: "base" }),
      );
    }
    if (lines.length)
      sections.push(`### ${title}\n\n${lines.join(title === "Contributors" ? "\n" : "\n\n")}`);
  }
  return sections.join("\n\n");
}

async function formatChangelog(
  path,
  { name, version },
  { tags, previousVersion, recovery = false },
) {
  let content;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (recovery && error?.code === "ENOENT") return false;
    throw error;
  }
  const header = `## ${version}\n`;
  const start = content.indexOf(header);
  if (start < 0) {
    if (recovery) return false;
    throw new Error(`Could not find ${version} in ${path}.`);
  }
  const bodyStart = start + header.length;
  const next = content.indexOf("\n## ", bodyStart);
  const end = next < 0 ? content.length : next;
  const body = content.slice(bodyStart, end);
  if (
    recovery &&
    (!/^### (?:Major|Minor|Patch) Changes$/mu.test(body) ||
      !/^#### (?:🚀 Features|🐛 Bug Fixes|Other Changes|Internal|Dependencies)$/mu.test(body))
  )
    return false;
  const bump =
    ["major", "minor", "patch"].find((type) =>
      body.includes(`### ${type[0].toUpperCase()}${type.slice(1)} Changes`),
    ) ?? "patch";
  const previousHeading =
    next < 0 ? undefined : /^\n## (\S+)[ \t]*$/mu.exec(content.slice(next))?.[1];
  const previousTag = `${name}@${previousVersion ?? previousHeading}`;
  const currentTag = encodeURIComponent(`${name}@${version}`);
  const changesUrl = tags.has(previousTag)
    ? `https://github.com/vercel/eve/compare/${encodeURIComponent(previousTag)}...${currentTag}`
    : `https://github.com/vercel/eve/commits/${currentTag}`;
  const rendered = renderRelease({
    name,
    version,
    date: new Date().toISOString().slice(0, 10),
    bump,
    body,
    changesUrl,
  });
  await writeFile(path, `${content.slice(0, bodyStart)}\n${rendered}\n${content.slice(end)}`);
  return true;
}

async function main() {
  const before = await getPackages(process.cwd());
  const tags = new Set(
    execFileSync("git", ["tag", "--list"], { encoding: "utf8" }).trim().split("\n"),
  );
  const versions = new Map(
    before.packages.map(({ dir, packageJson }) => [dir, packageJson.version]),
  );
  let recovered = false;
  for (const { dir, packageJson } of before.packages) {
    if (await formatChangelog(join(dir, "CHANGELOG.md"), packageJson, { tags, recovery: true }))
      recovered = true;
  }
  const changesetFiles = await readdir(".changeset");
  if (
    recovered &&
    !changesetFiles.some(
      (file) => (file.endsWith(".md") && file !== "README.md") || file === "pre.json",
    )
  )
    return;
  execFileSync(process.execPath, ["node_modules/@changesets/cli/bin.js", "version"], {
    stdio: "inherit",
  });
  const after = await getPackages(process.cwd());
  for (const { dir, packageJson } of after.packages) {
    if (versions.get(dir) !== packageJson.version)
      await formatChangelog(join(dir, "CHANGELOG.md"), packageJson, {
        tags,
        previousVersion: versions.get(dir),
      });
  }
}

await main();

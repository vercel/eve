import { execFileSync } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getPackages } from "@manypkg/get-packages";

const sections = ["Breaking Changes", "Features", "Bug Fixes", "Dependencies"];

function renderRelease({ date, body, changes }) {
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
  const parts = [`Released ${date} · [${changes.label}](${changes.url})`];
  for (const title of sections) {
    const entries = groups.get(title) ?? [];
    if (entries.length) parts.push(`### ${title}\n\n${entries.join("\n")}`);
  }
  return parts.join("\n\n");
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
      !/^#### (?:Breaking Changes|Features|Bug Fixes|Other Changes|Internal|Dependencies)$/mu.test(
        body,
      ))
  )
    return false;
  // A version that never got a tag, such as one whose publish failed, falls
  // back to the newest older release that did. A stable release's notes
  // collect every prerelease since the last stable release, so it compares
  // with that release.
  const olderVersions = [...content.slice(end).matchAll(/^## (\S+)[ \t]*$/gmu)].map(
    (match) => match[1],
  );
  const stable = !version.includes("-");
  const previous = [previousVersion, ...olderVersions].find(
    (candidate) =>
      candidate && (!stable || !candidate.includes("-")) && tags.has(`${name}@${candidate}`),
  );
  const currentTag = encodeURIComponent(`${name}@${version}`);
  const changes = previous
    ? {
        label: `Compare with ${previous}`,
        url: `https://github.com/vercel/eve/compare/${encodeURIComponent(`${name}@${previous}`)}...${currentTag}`,
      }
    : { label: "View commits", url: `https://github.com/vercel/eve/commits/${currentTag}` };
  const rendered = renderRelease({
    date: new Date().toISOString().slice(0, 10),
    body,
    changes,
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

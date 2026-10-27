import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getPackages } from "@manypkg/get-packages";

const repository = "vercel/eve";
const markerPattern = /<!-- eve-changeset:([A-Za-z0-9_-]+) -->/gu;

function renderRelease({ version, date, bump, entries }) {
  const sections = [`### Release ${version} | ${date} | ${bump}`];
  for (const [category, title] of [
    ["feature", "🚀 Features"],
    ["bugfix", "🐛 Bug Fix"],
  ]) {
    const lines = entries
      .filter((entry) => entry.category === category)
      .map(
        (entry) =>
          `- ${entry.summary} [#${entry.pull.number}](https://github.com/${repository}/pull/${entry.pull.number})`,
      );
    if (lines.length) sections.push(`### ${title}\n\n${lines.join("\n")}`);
  }
  const dependencies = entries.flatMap((entry) => entry.dependencies ?? []);
  if (dependencies.length)
    sections.push(
      `### Dependencies\n\n${dependencies.map(({ name, newVersion }) => `- Updated ${name} to ${newVersion}.`).join("\n")}`,
    );
  const contributors = new Map();
  for (const entry of entries) {
    for (const login of [
      entry.pull?.author,
      ...(entry.pull?.coauthors ?? []),
      ...(entry.contributors ?? []),
    ]) {
      if (login && !login.endsWith("[bot]")) contributors.set(login.toLowerCase(), login);
    }
  }
  if (contributors.size) {
    const lines = [...contributors.values()]
      .sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }))
      .map((login) => `- [@${login}](https://github.com/${login})`);
    sections.push(`### Contributors\n\n${lines.join("\n")}`);
  }
  return sections.join("\n\n");
}

async function formatChangelog(path, version) {
  const content = await readFile(path, "utf8");
  const header = `## ${version}\n`;
  const start = content.indexOf(header);
  if (start < 0) throw new Error(`Could not find ${version} in ${path}.`);
  const bodyStart = start + header.length;
  const next = content.indexOf("\n## ", bodyStart);
  const end = next < 0 ? content.length : next;
  const body = content.slice(bodyStart, end);
  const bump =
    ["major", "minor", "patch"].find((type) =>
      body.includes(`### ${type[0].toUpperCase()}${type.slice(1)} Changes`),
    ) ?? "patch";
  const entries = [...body.matchAll(markerPattern)].map((match) =>
    JSON.parse(Buffer.from(match[1], "base64url").toString("utf8")),
  );
  const rendered = renderRelease({
    version,
    date: new Date().toISOString().slice(0, 10),
    bump,
    entries,
  });
  await writeFile(path, `${content.slice(0, bodyStart)}\n${rendered}\n${content.slice(end)}`);
}

async function main() {
  execFileSync(process.execPath, ["scripts/check-changesets.mjs"], { stdio: "inherit" });
  const before = await getPackages(process.cwd());
  const versions = new Map(
    before.packages.map(({ dir, packageJson }) => [dir, packageJson.version]),
  );
  execFileSync(process.execPath, ["node_modules/@changesets/cli/bin.js", "version"], {
    stdio: "inherit",
  });
  const after = await getPackages(process.cwd());
  for (const { dir, packageJson } of after.packages) {
    if (versions.get(dir) !== packageJson.version)
      await formatChangelog(join(dir, "CHANGELOG.md"), packageJson.version);
  }
}

if (import.meta.main) await main();

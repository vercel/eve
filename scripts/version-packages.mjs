import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getPackages } from "@manypkg/get-packages";

function renderRelease({ version, date, bump, body }) {
  const sections = [`### Release ${version} | ${date} | ${bump}`];
  const groups = new Map();
  const headings = [...body.matchAll(/^#{3,4} (.+)$/gmu)];
  for (let i = 0; i < headings.length; i++) {
    const match = headings[i];
    if (!match[0].startsWith("#### ")) continue;
    const lines = body
      .slice(match.index + match[0].length, headings[i + 1]?.index)
      .trim()
      .split("\n");
    const group = groups.get(match[1]) ?? [];
    group.push(...lines.filter(Boolean));
    groups.set(match[1], group);
  }
  for (const title of ["🚀 Features", "🐛 Bug Fix", "Dependencies", "Contributors"]) {
    let lines = groups.get(title) ?? [];
    if (title === "Contributors") {
      lines = [...new Map(lines.map((line) => [line.toLowerCase(), line])).values()].sort((a, b) =>
        a.localeCompare(b, "en", { sensitivity: "base" }),
      );
    }
    if (lines.length) sections.push(`### ${title}\n\n${lines.join("\n")}`);
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
  const rendered = renderRelease({
    version,
    date: new Date().toISOString().slice(0, 10),
    bump,
    body,
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

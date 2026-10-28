import { access, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const packageRoot = resolve(process.argv[2] ?? ".");
const changelogPath = join(packageRoot, "CHANGELOG.md");
const backupPath = join(
  dirname(packageRoot),
  `.${basename(packageRoot)}.eve-changelog-backup.json`,
);
try {
  await access(backupPath);
  throw new Error(
    `A changelog backup already exists at ${backupPath}. Run the postpack script to restore it before packing.`,
  );
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
const directory = manifest.repository?.directory;
if (typeof directory !== "string" || !/^packages\/[a-z0-9][a-z0-9-]*$/u.test(directory)) {
  throw new Error(`Package ${manifest.name} must declare its repository directory.`);
}

const source = await readFile(changelogPath, "utf8");
const lines = source.split(/\r?\n/u);
const headings = [];
function nextFence(fence, line) {
  const delimiter = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
  if (!fence) return delimiter;
  return delimiter &&
    delimiter[0] === fence[0] &&
    delimiter.length >= fence.length &&
    /^ {0,3}(?:`+|~+)\s*$/u.test(line)
    ? undefined
    : fence;
}
let fence;
for (const [index, line] of lines.entries()) {
  const next = nextFence(fence, line);
  if (fence || next) {
    fence = next;
    continue;
  }
  const heading = /^##[ \t]+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)[ \t]*$/u.exec(
    line,
  );
  if (heading) headings.push({ index, version: heading[1] });
}
const requested = manifest.version;
const base = requested.split("+")[0];
const index = headings.findIndex(({ version }) => version === requested);
const selected = index >= 0 ? index : headings.findIndex(({ version }) => version === base);
if (selected < 0) throw new Error(`No changelog entry for ${manifest.name}@${requested}.`);

const entryLines = lines.slice(headings[selected].index + 1, headings[selected + 1]?.index);
const first = entryLines.findIndex((line) => line.trim());
const releasePrefix = `### Release ${manifest.name}@${headings[selected].version} | `;
const hasReleaseHeading = first >= 0 && entryLines[first].startsWith(releasePrefix);
const releaseHeading = hasReleaseHeading
  ? `# ${entryLines[first].slice(4)}`
  : `# Release ${manifest.name}@${headings[selected].version}`;
const bodyLines = entryLines.slice(hasReleaseHeading ? first + 1 : 0);
let bodyFence;
const entry = bodyLines
  .map((line) => {
    const next = nextFence(bodyFence, line);
    const inside = bodyFence || next;
    bodyFence = next;
    return inside ? line : line.replace(/^### /u, "## ");
  })
  .join("\n")
  .trim();
const gitRevision = /\+git\.([a-f0-9]{16})$/iu.exec(requested)?.[1];
const preview =
  gitRevision || requested !== headings[selected].version
    ? `> This is a development build; these notes describe ${headings[selected].version} and may not include every change in the build.\n\n`
    : "";
const tag = encodeURIComponent(`${manifest.name}@${headings[selected].version}`);
const sourceSha = process.env.VERCEL_GIT_COMMIT_SHA;
const fullSha =
  sourceSha &&
  /^[a-f0-9]{40}$/iu.test(sourceSha) &&
  sourceSha.toLowerCase().startsWith(gitRevision?.toLowerCase() ?? "-")
    ? sourceSha
    : undefined;
const ref = gitRevision && selected === 0 ? (fullSha ?? gitRevision) : `refs/tags/${tag}`;
const fullHistory = `https://raw.githubusercontent.com/vercel/eve/${ref}/${directory}/CHANGELOG.md`;
const content = `${releaseHeading}\n\n${preview}${entry}\n\nFor an upgrade across multiple releases, review each version between the installed and target versions in the [target version's changelog](${fullHistory}).\n`;
await writeFile(backupPath, JSON.stringify({ source, content }), { flag: "wx" });
try {
  await writeFile(changelogPath, content);
} catch (error) {
  await writeFile(changelogPath, source);
  await unlink(backupPath);
  throw error;
}

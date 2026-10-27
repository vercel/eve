import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const packageRoot = resolve(process.argv[2] ?? ".");
const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
const directory = manifest.repository?.directory;
if (typeof directory !== "string" || !/^packages\/[a-z0-9][a-z0-9-]*$/u.test(directory)) {
  throw new Error(`Package ${manifest.name} must declare its repository directory.`);
}

const source = await readFile(join(packageRoot, "CHANGELOG.md"), "utf8");
const lines = source.split(/\r?\n/u);
const headings = [];
let fence;
for (const [index, line] of lines.entries()) {
  const delimiter = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
  if (fence) {
    if (
      delimiter &&
      delimiter[0] === fence[0] &&
      delimiter.length >= fence.length &&
      /^ {0,3}(?:`+|~+)\s*$/u.test(line)
    )
      fence = undefined;
    continue;
  }
  if (delimiter) {
    fence = delimiter;
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

const entry = lines
  .slice(headings[selected].index, headings[selected + 1]?.index)
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
const content = `# ${manifest.name}\n\n${preview}${entry}\n\nFor upgrades across versions, review the [full changelog through this version (raw Markdown)](${fullHistory}).\n`;
await mkdir(join(packageRoot, "dist"), { recursive: true });
await writeFile(join(packageRoot, "dist", "CHANGELOG.md"), content);

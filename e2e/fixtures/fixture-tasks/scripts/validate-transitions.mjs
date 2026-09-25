import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const fixtureRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const evalsRoot = join(fixtureRoot, "evals");
const files = await collectEvalFiles(evalsRoot);
const issues = [];

for (const file of files) {
  const source = await readFile(join(evalsRoot, file), "utf8");
  const anchors = [...source.matchAll(/primary:\s*"([^"]+)"/gu)].map((match) => match[1]);
  if (!source.includes("defineTaskEval(")) {
    issues.push(`${file}: task evals must use defineTaskEval().`);
  }
  if (source.includes("defineEval(")) {
    issues.push(`${file}: direct defineEval() bypasses transition validation.`);
  }
  if (anchors.length !== 1) {
    issues.push(
      `${file}: expected exactly one primary transition anchor; found ${anchors.length}.`,
    );
    continue;
  }
  const anchor = anchors[0];
  const fileName = file.split("/").at(-1);
  if (fileName !== `${anchor}.eval.ts` && !fileName?.startsWith(`${anchor}.`)) {
    issues.push(`${file}: filename must derive from primary anchor ${anchor}.`);
  }
  if (!source.includes("dimensions:")) {
    issues.push(`${file}: transition declaration must factor scenario dimensions.`);
  }
}

if (issues.length > 0) {
  process.stderr.write(`${issues.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Validated ${files.length} task eval transition declarations.\n`);
}

async function collectEvalFiles(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await collectEvalFiles(join(directory, entry.name), relativePath)));
    } else if (entry.name.endsWith(".eval.ts")) {
      files.push(relativePath);
    }
  }
  return files.sort();
}

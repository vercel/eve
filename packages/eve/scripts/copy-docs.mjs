import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { splitPage } from "./agent-docs.mjs";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const monorepoRoot = fileURLToPath(new URL("../../..", import.meta.url));

// Scaffolded apps tell agents to read `node_modules/eve/docs/`. The package-local
// README is already listed in package.json#files; do not overwrite it with the
// monorepo root README.
const packageDocsDir = join(packageRoot, "docs");
const oldDistDocsDir = join(packageRoot, "dist", "docs");

await rm(packageDocsDir, { recursive: true, force: true });
await rm(oldDistDocsDir, { recursive: true, force: true });
await cp(join(monorepoRoot, "docs"), packageDocsDir, { recursive: true });

// Agents read the raw file, where the site's <EveCodeBenchmark /> component
// would render nothing, so inline the same snapshot as a Markdown table.
const benchmarkPage = join(packageDocsDir, "code-extension.mdx");
const page = await readFile(benchmarkPage, "utf8").catch((error) => {
  if (error.code === "ENOENT") return null;
  throw error;
});
if (page !== null) {
  const { renderBenchmarkMarkdown } =
    await import("../../../apps/docs/lib/evals/eve-code-format.ts");
  const snapshot = JSON.parse(
    await readFile(join(monorepoRoot, "apps/docs/lib/evals/eve-code-benchmark.json"), "utf8"),
  );
  await writeFile(
    benchmarkPage,
    page.replace(/<EveCodeBenchmark dataset="([^"]+)" \/>/gu, (_, dataset) =>
      renderBenchmarkMarkdown(snapshot.datasets[dataset], dataset),
    ),
  );
}

// Long pages become an outline plus section files; see agent-docs.mjs. The
// entry points agents read in full stay whole.
const WHOLE_PAGES = new Set(["README.md", "quick-reference.md"]);
const pages = (await readdir(packageDocsDir, { recursive: true })).filter(
  (path) => /\.mdx?$/u.test(path) && !WHOLE_PAGES.has(path),
);
for (const path of pages) {
  const file = join(packageDocsDir, path);
  const split = splitPage(await readFile(file, "utf8"), path.split("/").at(-1));
  if (split === null) continue;
  const sectionsDir = file.replace(/\.mdx?$/u, "");
  if (existsSync(sectionsDir)) {
    throw new Error(`Cannot split ${path}: ${sectionsDir} already exists.`);
  }
  await mkdir(sectionsDir, { recursive: true });
  await writeFile(file, split.outline);
  for (const chunk of split.chunks) {
    await writeFile(join(sectionsDir, chunk.name), chunk.content);
  }
}

import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderBenchmarkMarkdown } from "../../../apps/docs/lib/evals/eve-code-format.ts";

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

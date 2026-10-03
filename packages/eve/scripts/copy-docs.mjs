import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
const snapshot = JSON.parse(
  await readFile(join(monorepoRoot, "apps/docs/lib/evals/eve-code-benchmark.json"), "utf8"),
);
const page = await readFile(benchmarkPage, "utf8");
await writeFile(
  benchmarkPage,
  page.replace(/<EveCodeBenchmark dataset="([^"]+)" \/>/gu, (_, dataset) =>
    benchmarkTable(snapshot.datasets[dataset], dataset),
  ),
);

function benchmarkTable(results, dataset) {
  if (!results) return `No published ${dataset} results yet.`;
  const pct = (value) => `${Math.round(value * 100)}%`;
  const rows = [...results.harnesses]
    .sort(
      (a, b) => b.resolveRate.estimate - a.resolveRate.estimate || a.latencyP50Ms - b.latencyP50Ms,
    )
    .map(
      (h) =>
        `| \`${h.harness}\` | ${pct(h.resolveRate.estimate)} (${h.resolved}/${h.attempts}) | ${pct(h.resolveRate.low)}–${pct(h.resolveRate.high)} | ${(h.latencyP50Ms / 1000).toFixed(1)}s | ${(h.latencyP90Ms / 1000).toFixed(1)}s | ${h.measuredAt?.slice(0, 10) ?? "—"} |`,
    );
  return [
    `${results.tasks} tasks × ${results.attempts} attempts on \`${results.model.id}\`. Snapshot updated ${results.generatedAt.slice(0, 10)}.`,
    "",
    "| Harness | Resolved | 95% interval | Median latency | p90 latency | Measured |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

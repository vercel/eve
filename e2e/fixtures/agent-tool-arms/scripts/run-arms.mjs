import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const cwd = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(process.env.EVE_ARMS_OUTPUT ?? `${cwd}/results/measurements.jsonl`);
mkdirSync(dirname(output), { recursive: true });
const repetitions = Number(process.env.EVE_ARMS_REPETITIONS ?? 1);
const models = (
  process.env.EVE_ARMS_MODELS ?? "openai/gpt-6.1-sol,anthropic/claude-opus-5.5"
).split(",");
const arms = (process.env.EVE_ARMS_MODES ?? "direct,deferred,subagents").split(",");
const sizes = (process.env.EVE_ARMS_SIZES ?? "moderate,large").split(",");
for (let repetition = 1; repetition <= repetitions; repetition++) {
  for (const model of models)
    for (const size of sizes)
      for (const arm of arms) {
        const key = `${model.replaceAll("/", "-")}-${size}-${arm}-${repetition}`;
        console.log(`Running ${key}`);
        const run = spawnSync("pnpm", ["exec", "eve", "eval", "--strict", "--verbose"], {
          cwd,
          encoding: "utf8",
          timeout: 900_000,
          maxBuffer: 32 * 1024 * 1024,
          env: {
            ...process.env,
            EVE_E2E_MODEL: model,
            EVE_ARMS_MODE: arm,
            EVE_ARMS_SIZE: size,
            EVE_ARMS_REPETITION: String(repetition),
            EVE_ARMS_OUTPUT: output,
          },
        });
        writeFileSync(`${dirname(output)}/${key}.log`, (run.stdout ?? "") + (run.stderr ?? ""));
        console.log(
          `Exit ${run.status}; ${(run.stdout ?? "").match(/Results: .*/)?.[0] ?? run.error ?? "No result summary"}`,
        );
      }
}
const rows = existsSync(output)
  ? readFileSync(output, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
  : [];
const lines = [
  "| Model | Size | Arm | Success | Mean input tokens | Cache read ratio | Mean model calls | Mean latency (s) |",
  "|---|---|---|---:|---:|---:|---:|---:|",
];
for (const model of models)
  for (const size of sizes)
    for (const arm of arms) {
      const r = rows.filter((r) => r.model === model && r.size === size && r.arm === arm);
      const sum = (key) => r.reduce((n, row) => n + row[key], 0);
      const mean = (key) => (sum(key) / r.length).toFixed(1);
      lines.push(
        `| ${model} | ${size} | ${arm} | ${r.filter((r) => r.success).length}/${10 * repetitions} | ${mean("inputTokens")} | ${((100 * sum("cacheReadTokens")) / sum("inputTokens")).toFixed(1)}% | ${mean("modelCalls")} | ${(sum("latencyMs") / r.length / 1000).toFixed(2)} |`,
      );
    }
writeFileSync(`${dirname(output)}/summary.md`, lines.join("\n") + "\n");
console.log(lines.join("\n"));

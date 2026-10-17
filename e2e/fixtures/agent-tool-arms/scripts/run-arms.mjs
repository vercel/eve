import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readMatrix, readRows, summarize } from "./summary.mjs";

const cwd = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// `--summary [file]` prints the table for an existing dataset (the committed
// baseline by default) and writes nothing.
const summaryAt = process.argv.indexOf("--summary");
if (summaryAt !== -1) {
  const path = resolve(process.argv[summaryAt + 1] ?? `${cwd}/results/baseline/measurements.jsonl`);
  const rows = readRows(path);
  const matrix = readMatrix(path);
  process.stdout.write(summarize(rows, matrix));
  process.exit(0);
}

// Every execution gets its own dataset: a fresh directory under results/runs/,
// or EVE_ARMS_OUTPUT if that file doesn't exist yet. Rows are never appended
// to an earlier execution's file, so the summary covers this execution only.
const output = resolve(
  process.env.EVE_ARMS_OUTPUT ??
    `${cwd}/results/runs/${new Date().toISOString().replaceAll(":", "-")}/measurements.jsonl`,
);
if (
  (existsSync(output) && statSync(output).size > 0) ||
  existsSync(join(dirname(output), "matrix.json"))
) {
  console.error(`${dirname(output)} already holds a dataset; pass a new EVE_ARMS_OUTPUT path.`);
  process.exit(1);
}
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, "");

const repetitions = Number(process.env.EVE_ARMS_REPETITIONS ?? 3);
const models = (
  process.env.EVE_ARMS_MODELS ?? "openai/gpt-6.1-sol,anthropic/claude-opus-5.5"
).split(",");
// Program arms (`js`, `py`) are opt-in: add them to EVE_ARMS_MODES once
// `agent/lib/program-arms.ts` configures their runtime.
const arms = (process.env.EVE_ARMS_MODES ?? "direct,deferred,subagents").split(",");
const sizes = (process.env.EVE_ARMS_SIZES ?? "moderate,large").split(",");
const matrix = { models, sizes, arms, repetitions };
writeFileSync(join(dirname(output), "matrix.json"), JSON.stringify(matrix, null, 2) + "\n");
// A shell started inside an `eve dev` session (an agent's sandbox, a dev
// terminal) inherits that session's local-world wiring. Passed through, the
// eval's queue deliveries go to the outer dev server and every run hangs on
// "Workflow delivery is not trusted", so drop it before spawning `eve eval`.
const baseEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => key !== "WORKFLOW_LOCAL_BASE_URL" && !key.startsWith("EVE_DEV_"),
  ),
);

console.log(`Writing ${output}`);
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
            ...baseEnv,
            EVE_E2E_MODEL: model,
            EVE_ARMS_MODE: arm,
            EVE_ARMS_SIZE: size,
            EVE_ARMS_REPETITION: String(repetition),
            EVE_ARMS_OUTPUT: output,
          },
        });
        writeFileSync(join(dirname(output), `${key}.log`), (run.stdout ?? "") + (run.stderr ?? ""));
        console.log(
          `Exit ${run.status}; ${(run.stdout ?? "").match(/Results: .*/)?.[0] ?? run.error ?? "No result summary"}`,
        );
      }
}

const table = summarize(readRows(output), matrix);
writeFileSync(join(dirname(output), "summary.md"), table);
console.log(table);

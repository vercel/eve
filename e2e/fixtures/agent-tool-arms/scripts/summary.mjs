import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const TASKS = 10;

/** Rows of one dataset (a JSONL file written by `measure.ts`). */
export function readRows(path) {
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map(JSON.parse);
}

/**
 * The configurations an execution asked for, saved as `matrix.json` beside its
 * rows, so a later summary shows configurations that recorded nothing.
 */
export function readMatrix(rowsPath) {
  return JSON.parse(readFileSync(join(dirname(rowsPath), "matrix.json"), "utf8"));
}

/**
 * Markdown table with one line per model, size and arm in `matrix` (`{ models,
 * sizes, arms, repetitions }`), then any configuration that has rows but isn't
 * in it. `Runs` compares the rows recorded with `TASKS` per repetition, so a
 * configuration whose eval process died before writing shows as 0/30.
 */
export function summarize(rows, matrix) {
  const lines = [
    "| Model | Size | Arm | Success | Runs | Mean input tokens | Cache read ratio | Mean model calls | Mean actions | Mean program attempts | Mean latency (s) | Error classes |",
    "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|",
  ];
  const keys = [];
  for (const model of matrix.models)
    for (const size of matrix.sizes)
      for (const arm of matrix.arms) keys.push(JSON.stringify([model, size, arm]));
  for (const r of rows) keys.push(JSON.stringify([r.model, r.size, r.arm]));
  for (const key of new Set(keys)) {
    const [model, size, arm] = JSON.parse(key);
    const r = rows.filter((r) => r.model === model && r.size === size && r.arm === arm);
    const sum = (k) => r.reduce((n, row) => n + (row[k] ?? 0), 0);
    const mean = (k) => (r.length ? (sum(k) / r.length).toFixed(1) : "-");
    const errors = {};
    for (const row of r)
      for (const c of [row.errorClass, ...(row.programErrorClasses ?? [])])
        if (c) errors[c] = (errors[c] ?? 0) + 1;
    const errorText =
      Object.entries(errors)
        .map(([c, n]) => `${c} ×${n}`)
        .join(", ") || "-";
    const cache = sum("inputTokens")
      ? `${((100 * sum("cacheReadTokens")) / sum("inputTokens")).toFixed(1)}%`
      : "-";
    lines.push(
      `| ${model} | ${size} | ${arm} | ${r.filter((r) => r.success).length}/${r.length} | ${r.length}/${TASKS * matrix.repetitions} | ${mean("inputTokens")} | ${cache} | ${mean("modelCalls")} | ${mean("actions")} | ${mean("programAttempts")} | ${r.length ? (sum("latencyMs") / r.length / 1000).toFixed(2) : "-"} | ${errorText} |`,
    );
  }
  return lines.join("\n") + "\n";
}

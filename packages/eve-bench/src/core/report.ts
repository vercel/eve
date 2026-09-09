import type { JobResult, TrialResult } from "./result.ts";

export type ReportFormat = "console" | "json" | "junit";

export function formatReport(result: JobResult, format: ReportFormat): string {
  switch (format) {
    case "json":
      return `${JSON.stringify(result, null, 2)}\n`;
    case "junit":
      return junit(result);
    case "console":
      return console_(result);
  }
}

function console_(result: JobResult): string {
  const lines = [
    `${result.job}  ${result.harness} / ${result.model}  ${result.dataset.name}@${result.dataset.version}`,
    "",
  ];
  const byTask = groupByTask(result.trials);
  for (const [task, trials] of byTask) {
    const rewards = trials.map((trial) => (trial.reward === null ? "-" : trial.reward.toFixed(2)));
    const errors = trials.filter((trial) => trial.error || trial.agent.status === "timeout").length;
    lines.push(
      `${task.padEnd(44)} ${rewards.join(" ").padEnd(16)} ${errors > 0 ? `${errors} error(s)` : ""}`.trimEnd(),
    );
  }
  const { summary } = result;
  lines.push(
    "",
    `tasks ${summary.tasks}  attempts ${summary.attempts}  resolved ${summary.resolved}  mean reward ${summary.meanReward.toFixed(3)}`,
  );
  return `${lines.join("\n")}\n`;
}

function junit(result: JobResult): string {
  const failures = result.trials.filter((trial) => (trial.reward ?? 0) < 1).length;
  const cases = result.trials.map((trial) => {
    const time = ((trial.agent.durationMs + trial.verifier.durationMs) / 1000).toFixed(3);
    const name = escape(`${trial.task} #${trial.attempt}`);
    if ((trial.reward ?? 0) >= 1) return `    <testcase name="${name}" time="${time}"/>`;
    const message = escape(
      trial.error ??
        `reward ${trial.reward ?? "none"}; agent ${trial.agent.status}; verifier ${trial.verifier.status}`,
    );
    return `    <testcase name="${name}" time="${time}">\n      <failure message="${message}"/>\n    </testcase>`;
  });
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<testsuites>`,
    `  <testsuite name="${escape(result.job)}" tests="${result.trials.length}" failures="${failures}">`,
    ...cases,
    `  </testsuite>`,
    `</testsuites>`,
    "",
  ].join("\n");
}

export interface TaskDelta {
  readonly task: string;
  readonly base: number | null;
  readonly candidate: number | null;
  readonly delta: number | null;
}

export function diffJobs(base: JobResult, candidate: JobResult): TaskDelta[] {
  const baseMeans = meanByTask(base.trials);
  const candidateMeans = meanByTask(candidate.trials);
  const tasks = [...new Set([...baseMeans.keys(), ...candidateMeans.keys()])].sort();
  return tasks.map((task) => {
    const b = baseMeans.get(task) ?? null;
    const c = candidateMeans.get(task) ?? null;
    return { task, base: b, candidate: c, delta: b === null || c === null ? null : c - b };
  });
}

export function formatDiff(deltas: readonly TaskDelta[]): string {
  const lines = deltas.map((row) => {
    const fmt = (value: number | null) =>
      value === null ? "   -  " : value.toFixed(3).padStart(6);
    const delta =
      row.delta === null
        ? ""
        : row.delta === 0
          ? ""
          : row.delta > 0
            ? `+${row.delta.toFixed(3)}`
            : row.delta.toFixed(3);
    return `${row.task.padEnd(44)} ${fmt(row.base)} -> ${fmt(row.candidate)}  ${delta}`.trimEnd();
  });
  const changed = deltas.filter((row) => row.delta !== null && row.delta !== 0);
  const net = changed.reduce((sum, row) => sum + (row.delta ?? 0), 0);
  lines.push("", `${changed.length} task(s) changed, net ${net >= 0 ? "+" : ""}${net.toFixed(3)}`);
  return `${lines.join("\n")}\n`;
}

function groupByTask(trials: readonly TrialResult[]): Map<string, TrialResult[]> {
  const groups = new Map<string, TrialResult[]>();
  for (const trial of trials) {
    const list = groups.get(trial.task) ?? [];
    list.push(trial);
    groups.set(trial.task, list);
  }
  return groups;
}

function meanByTask(trials: readonly TrialResult[]): Map<string, number> {
  const means = new Map<string, number>();
  for (const [task, group] of groupByTask(trials)) {
    means.set(task, group.reduce((sum, trial) => sum + (trial.reward ?? 0), 0) / group.length);
  }
  return means;
}

function escape(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
}

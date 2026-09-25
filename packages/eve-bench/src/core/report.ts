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
    const rewards = trials.map((trial) =>
      trial.invalid ? "x" : trial.reward === null ? "-" : trial.reward.toFixed(2),
    );
    const invalid = trials.filter((trial) => trial.invalid);
    const timeouts = trials.filter((trial) => !trial.invalid && trial.agent.status === "timeout");
    const notes = [
      ...invalid.map((trial) => `#${trial.attempt} invalid(${trial.invalid!.phase})`),
      ...(timeouts.length > 0 ? [`${timeouts.length} agent timeout(s)`] : []),
    ];
    lines.push(`${task.padEnd(44)} ${rewards.join(" ").padEnd(16)} ${notes.join(", ")}`.trimEnd());
  }
  const { summary } = result;
  const invalid = Object.entries(summary.invalid)
    .filter(([, count]) => count > 0)
    .map(([phase, count]) => `${phase} ${count}`);
  const mean = summary.meanReward === null ? "-" : summary.meanReward.toFixed(3);
  lines.push(
    "",
    `tasks ${summary.tasks}  attempts ${summary.attempts}  scored ${summary.scored}  resolved ${summary.resolved}  mean reward ${mean}`,
  );
  if (invalid.length > 0) {
    lines.push(`invalid attempts excluded from scoring: ${invalid.join(", ")}`);
    for (const trial of result.trials.filter((trial) => trial.invalid)) {
      lines.push(
        `  ${trial.task} #${trial.attempt} [${trial.invalid!.phase}] ${trial.invalid!.reason}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

function junit(result: JobResult): string {
  const invalid = result.trials.filter((trial) => trial.invalid).length;
  const failures = result.trials.filter(
    (trial) => !trial.invalid && (trial.reward ?? 0) < 1,
  ).length;
  const cases = result.trials.map((trial) => {
    const time = ((trial.agent.durationMs + trial.verifier.durationMs) / 1000).toFixed(3);
    const name = escape(`${trial.task} #${trial.attempt}`);
    if (trial.invalid) {
      const message = escape(`invalid (${trial.invalid.phase}): ${trial.invalid.reason}`);
      return `    <testcase name="${name}" time="${time}">\n      <error message="${message}"/>\n    </testcase>`;
    }
    if ((trial.reward ?? 0) >= 1) return `    <testcase name="${name}" time="${time}"/>`;
    const message = escape(
      `reward ${trial.reward ?? "none"}; agent ${trial.agent.status}; verifier ${trial.verifier.status}`,
    );
    return `    <testcase name="${name}" time="${time}">\n      <failure message="${message}"/>\n    </testcase>`;
  });
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<testsuites>`,
    `  <testsuite name="${escape(result.job)}" tests="${result.trials.length}" failures="${failures}" errors="${invalid}">`,
    ...cases,
    `  </testsuite>`,
    `</testsuites>`,
    "",
  ].join("\n");
}

export interface TaskDelta {
  readonly task: string;
  /** Mean reward over scored attempts; null when the job has none for this task. */
  readonly base: number | null;
  readonly candidate: number | null;
  readonly delta: number | null;
  readonly baseInvalid: number;
  readonly candidateInvalid: number;
}

export function diffJobs(base: JobResult, candidate: JobResult): TaskDelta[] {
  const baseStats = statsByTask(base.trials);
  const candidateStats = statsByTask(candidate.trials);
  const tasks = [...new Set([...baseStats.keys(), ...candidateStats.keys()])].sort();
  return tasks.map((task) => {
    const b = baseStats.get(task);
    const c = candidateStats.get(task);
    const baseMean = b?.mean ?? null;
    const candidateMean = c?.mean ?? null;
    return {
      task,
      base: baseMean,
      candidate: candidateMean,
      delta: baseMean === null || candidateMean === null ? null : candidateMean - baseMean,
      baseInvalid: b?.invalid ?? 0,
      candidateInvalid: c?.invalid ?? 0,
    };
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
    const invalid =
      row.baseInvalid + row.candidateInvalid > 0
        ? `invalid ${row.baseInvalid} -> ${row.candidateInvalid}`
        : "";
    return `${row.task.padEnd(44)} ${fmt(row.base)} -> ${fmt(row.candidate)}  ${delta.padEnd(7)} ${invalid}`.trimEnd();
  });
  const changed = deltas.filter((row) => row.delta !== null && row.delta !== 0);
  const net = changed.reduce((sum, row) => sum + (row.delta ?? 0), 0);
  const invalid = deltas.reduce((sum, row) => sum + row.baseInvalid + row.candidateInvalid, 0);
  lines.push("", `${changed.length} task(s) changed, net ${net >= 0 ? "+" : ""}${net.toFixed(3)}`);
  if (invalid > 0) {
    lines.push(`${invalid} invalid attempt(s) excluded; compare only after resolving them`);
  }
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

function statsByTask(
  trials: readonly TrialResult[],
): Map<string, { mean: number | null; invalid: number }> {
  const stats = new Map<string, { mean: number | null; invalid: number }>();
  for (const [task, group] of groupByTask(trials)) {
    const scored = group.filter((trial) => !trial.invalid);
    stats.set(task, {
      mean:
        scored.length === 0
          ? null
          : scored.reduce((sum, trial) => sum + (trial.reward ?? 0), 0) / scored.length,
      invalid: group.length - scored.length,
    });
  }
  return stats;
}

function escape(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
}

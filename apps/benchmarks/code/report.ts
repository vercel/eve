import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { DATASET_SOURCES } from "./datasets.ts";
import type {
  BenchmarkRunOptions,
  ConfidenceInterval,
  HarnessName,
  HarnessScore,
  TaskSpec,
  TrialResult,
} from "./types.ts";

function quantile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

/** Deterministic PRNG (mulberry32) so bootstrap CIs are reproducible across reruns. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function bootstrapResolveRate(
  trialsByTask: readonly (readonly number[])[],
  resamples = 2000,
): ConfidenceInterval {
  const flat = trialsByTask.flat();
  if (flat.length === 0) return { estimate: 0, low: 0, high: 0 };
  const estimate = flat.reduce((a, b) => a + b, 0) / flat.length;
  if (trialsByTask.length <= 1) return { estimate, low: estimate, high: estimate };

  const rand = seededRandom(0x5eed1234);
  const samples: number[] = [];
  for (let i = 0; i < resamples; i++) {
    let resolved = 0;
    let total = 0;
    for (let j = 0; j < trialsByTask.length; j++) {
      const bucket = trialsByTask[Math.floor(rand() * trialsByTask.length)]!;
      for (const value of bucket) {
        resolved += value;
        total++;
      }
    }
    samples.push(total > 0 ? resolved / total : 0);
  }
  samples.sort((a, b) => a - b);
  return {
    estimate,
    low: quantile(samples, 0.025),
    high: quantile(samples, 0.975),
  };
}

export function scoreHarness(
  harness: HarnessName,
  version: string,
  tasks: readonly TaskSpec[],
  trials: readonly TrialResult[],
): HarnessScore {
  const byTask = tasks.map((task) =>
    trials.filter((t) => t.task === task.name).map((t) => (t.reward === 1 ? 1 : 0)),
  );
  const resolved = trials.filter((t) => t.reward === 1).length;
  const incomplete = trials.filter((t) => t.reward === null).length;
  const attempts = trials.length;
  const resolveRate = bootstrapResolveRate(byTask);

  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let costUsd = 0;
  let allPriced = attempts > 0;
  let hasUsage = false;
  const latencies: number[] = [];
  const steps: number[] = [];

  for (const trial of trials) {
    latencies.push(trial.agent.durationMs);
    if (typeof trial.overhead?.modelSteps === "number") steps.push(trial.overhead.modelSteps);
    if (trial.usage) {
      hasUsage = true;
      inputTokens += trial.usage.inputTokens;
      outputTokens += trial.usage.outputTokens;
      cachedTokens += trial.usage.cachedTokens;
      if (typeof trial.usage.costUsd === "number") costUsd += trial.usage.costUsd;
      else allPriced = false;
    } else {
      allPriced = false;
    }
  }

  latencies.sort((a, b) => a - b);
  steps.sort((a, b) => a - b);
  const totalCost = allPriced ? costUsd : null;

  return {
    contender: harness,
    version,
    resolved,
    attempts,
    incomplete,
    resolveRate,
    costUsd: totalCost,
    costPerResolvedUsd: totalCost !== null && resolved > 0 ? totalCost / resolved : null,
    inputTokens,
    outputTokens,
    cachedShare: hasUsage && inputTokens > 0 ? cachedTokens / inputTokens : null,
    latencyP50Ms: quantile(latencies, 0.5),
    latencyP90Ms: quantile(latencies, 0.9),
    medianSteps: steps.length > 0 ? quantile(steps, 0.5) : null,
  };
}

export function buildReport(input: {
  readonly options: BenchmarkRunOptions;
  readonly tasks: readonly TaskSpec[];
  readonly trials: readonly TrialResult[];
  readonly versions: Readonly<Partial<Record<HarnessName, string>>>;
}) {
  const { options, tasks, trials, versions } = input;
  const source = DATASET_SOURCES[options.dataset];
  const expectedTrialsPerHarness = tasks.length * options.attempts;

  const harnessResults = options.harnesses.map((harness) => {
    const hTrials = trials.filter((t) => t.harness === harness);
    const version =
      versions[harness] ??
      (harness === "eve-code" ? (options.sourceSha?.slice(0, 7) ?? "dev") : "unknown");
    const score = scoreHarness(harness, version, tasks, hTrials);
    return {
      harness,
      score,
      trials: hTrials,
      provenance: {
        harness:
          harness === "eve-code" ? { source: { gitSha: options.sourceSha ?? null } } : { version },
        source: options.sourceSha ? { revision: options.sourceSha } : null,
        run: options.runUrl ? { url: options.runUrl } : null,
      },
    };
  });

  const complete = harnessResults.every(
    (entry) => entry.trials.length === expectedTrialsPerHarness && entry.score.incomplete === 0,
  );
  const status = complete ? (harnessResults.length > 1 ? "comparable" : "measured") : "incomplete";

  const scores = harnessResults
    .map((entry) => entry.score)
    .sort((a, b) => {
      if (b.resolveRate.estimate !== a.resolveRate.estimate) {
        return b.resolveRate.estimate - a.resolveRate.estimate;
      }
      return a.latencyP50Ms - b.latencyP50Ms;
    });

  return {
    schemaVersion: 1,
    status,
    manifest: {
      dataset: { name: source.name, version: source.version },
      model: options.model,
      reasoning: options.reasoning,
      attempts: options.attempts,
      task: options.taskFilter ?? null,
      cohort: null,
      tasks: tasks.map((task) => task.name),
      harnesses: [...options.harnesses],
      source: options.sourceSha ?? null,
      runUrl: options.runUrl ?? null,
      generatedAt: new Date().toISOString(),
    },
    comparison: {
      comparison: {
        compatible: true,
        complete,
        results: harnessResults.map((entry) => ({
          harness: entry.harness,
          provenance: entry.provenance,
          trials: entry.trials,
        })),
        summary: { scores },
      },
      references: [],
    },
  };
}

function fmtDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${min}m${String(rem).padStart(2, "0")}s`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

export function renderMarkdownReport(report: ReturnType<typeof buildReport>): {
  readonly reportMd: string;
  readonly commentMd: string;
} {
  const { manifest } = report;
  const scores = report.comparison.comparison.summary.scores;
  const byHarness = new Map(
    report.comparison.comparison.results.map((entry) => [entry.harness, entry.trials]),
  );

  const lines: string[] = [
    `# eve-code benchmark (${manifest.dataset.name})`,
    "",
    `- Model: \`${manifest.model}\` (reasoning: \`${manifest.reasoning}\`)`,
    `- Dataset: \`${manifest.dataset.name}@${manifest.dataset.version}\` (${manifest.tasks.length} tasks × ${manifest.attempts} attempts)`,
    `- Status: **${report.status}**`,
    ...(manifest.source ? [`- Source: \`${manifest.source.slice(0, 10)}\``] : []),
    "",
    "## Summary",
    "",
    "| Harness | Version | Resolved | Rate (95% CI) | Latency p50 / p90 | Input / Output | Cache | Median steps |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];

  for (const s of scores) {
    const pct = `${Math.round(s.resolveRate.estimate * 100)}%`;
    const ci = `${Math.round(s.resolveRate.low * 100)}–${Math.round(s.resolveRate.high * 100)}%`;
    const cache = s.cachedShare !== null ? `${Math.round(s.cachedShare * 100)}%` : "—";
    const steps = s.medianSteps !== null ? String(Math.round(s.medianSteps)) : "—";
    lines.push(
      `| \`${s.contender}\` | \`${s.version}\` | ${s.resolved}/${s.attempts} | ${pct} (${ci}) | ${fmtDuration(s.latencyP50Ms)} / ${fmtDuration(s.latencyP90Ms)} | ${fmtTokens(s.inputTokens)}↑ ${fmtTokens(s.outputTokens)}↓ | ${cache} | ${steps} |`,
    );
  }

  lines.push("", "## Per-task resolve rates", "");
  const harnesses = manifest.harnesses;
  lines.push(`| Task | ${harnesses.map((h) => `\`${h}\``).join(" | ")} |`);
  lines.push(`| --- | ${harnesses.map(() => "---:").join(" | ")} |`);

  for (const taskName of manifest.tasks) {
    const cells = harnesses.map((harness) => {
      const taskTrials = (byHarness.get(harness) ?? []).filter((t) => t.task === taskName);
      const passed = taskTrials.filter((t) => t.reward === 1).length;
      return `${passed}/${taskTrials.length}`;
    });
    lines.push(`| ${taskName} | ${cells.join(" | ")} |`);
  }

  const reportMd = `${lines.join("\n")}\n`;
  const marker = `<!-- eve-code-bench:${manifest.dataset.name}:${manifest.model} -->`;
  const commentMd = `${marker}\n${reportMd}`;
  return { reportMd, commentMd };
}

export async function writeReportFiles(
  outputDir: string,
  report: ReturnType<typeof buildReport>,
): Promise<void> {
  const { reportMd, commentMd } = renderMarkdownReport(report);
  await Promise.all([
    writeFile(join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`),
    writeFile(join(outputDir, "report.md"), reportMd),
    writeFile(join(outputDir, "comment.md"), commentMd),
  ]);
}

export async function publishPrComment(input: {
  readonly commentPath: string;
  readonly token: string;
  readonly repository: string;
  readonly prNumber: number;
}): Promise<void> {
  const body = await readFile(input.commentPath, "utf8");
  const marker = body.split("\n", 1)[0] ?? "";
  const headers = {
    Authorization: `Bearer ${input.token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "eve-code-bench",
  };
  const baseUrl = `https://api.github.com/repos/${input.repository}`;
  const listRes = await fetch(`${baseUrl}/issues/${input.prNumber}/comments?per_page=100`, {
    headers,
  });
  if (!listRes.ok) {
    throw new Error(`Failed to list PR comments: ${listRes.status} ${await listRes.text()}`);
  }
  const comments = (await listRes.json()) as Array<{ id: number; body?: string }>;
  const existing = marker.startsWith("<!-- eve-code-bench:")
    ? comments.find((c) => typeof c.body === "string" && c.body.startsWith(marker))
    : undefined;

  const url = existing
    ? `${baseUrl}/issues/comments/${existing.id}`
    : `${baseUrl}/issues/${input.prNumber}/comments`;
  const method = existing ? "PATCH" : "POST";
  const updateRes = await fetch(url, { method, headers, body: JSON.stringify({ body }) });
  if (!updateRes.ok) {
    throw new Error(`Failed to publish PR comment: ${updateRes.status} ${await updateRes.text()}`);
  }
}

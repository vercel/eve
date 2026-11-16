import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { EveEvalResult, EveEvalRunSummary } from "eve/evals";
import type { EvalReporter } from "eve/evals/reporters";
import type { SessionStreamEvent } from "eve/client";
import { emptySessionView, foldEvents } from "eve/events";
import { z } from "zod";
import { traceTimelineRows } from "@agent/subagents/browser-agent/lib/trace/timeline";
import {
  browserBenchmarkActivity,
  browserBenchmarkActivityDurations,
  browserBenchmarkLiveViewUrl,
} from "@evals/browser/benchmark-activity";
import { browserBenchmarkEnv } from "@evals/browser/env";
import {
  measureWorkerTask,
  terminalWorkerMessage,
} from "@evals/browser/worker-events";
import type { BrowserBenchmark } from "@evals/browser/benchmark-schema";
import {
  type BrowserBenchmarkLiveStatus,
  updateBrowserBenchmarkLiveStatus,
} from "@evals/browser/live-status";

const tableWidths = [34, 8, 10, 12, 64] as const;
const taskNames = new Map<string, string>();
const completedTasks = new Map<
  string,
  ReturnType<typeof summarizeTaskResult>
>();
const liveActivities = new Map<string, string>();
const liveActivityDurations = new Map<string, string>();
const liveViewUrls = new Map<string, string>();

export const browserBenchmarkReporter: EvalReporter = {
  async onRunStart(evaluations) {
    taskNames.clear();
    completedTasks.clear();
    liveActivities.clear();
    liveActivityDurations.clear();
    liveViewUrls.clear();

    for (const evaluation of evaluations) {
      taskNames.set(evaluation.id, evaluation.description ?? evaluation.id);
    }

    console.log("");
    console.log(tableBorder());
    console.log(
      tableRow(["TASK", "RESULT", "TIME", "LLM COST", "TERMINAL MESSAGE"])
    );
    console.log(tableBorder());

    await updateLiveVariant((current) => ({
      ...current,
      completedAt: null,
      error: null,
      startedAt: new Date().toISOString(),
      status: "running",
      tasks: evaluations.map((evaluation) => ({
        activity: null,
        activityDurationsMs: {},
        browserLiveViewUrl: null,
        completedAt: null,
        costComplete: false,
        costUsd: null,
        durationMs: null,
        error: null,
        id: evaluation.id,
        judgeRationale: null,
        judgeScore: null,
        name: evaluation.description ?? evaluation.id,
        sessions: [],
        startedAt: null,
        status: "pending",
        success: null,
        terminalMessage: null,
        toolCalls: {},
        verdict: null,
      })),
    }));
  },
  async onEvalStart(event) {
    console.log(`START ${event.evaluation.description ?? event.evaluation.id}`);
    await updateLiveTask(event.evaluation.id, (task) => ({
      ...task,
      startedAt: event.startedAt,
      status: "running",
    }));
  },
  async onSessionStart(event) {
    console.log(
      `SESSION ${event.primary ? "root" : "worker"} ${event.sessionId} · ${event.evaluation.description ?? event.evaluation.id}`
    );
    await updateLiveTask(event.evaluation.id, (task) => ({
      ...task,
      sessions: task.sessions.some((session) => session.id === event.sessionId)
        ? task.sessions
        : [
            ...task.sessions,
            {
              id: event.sessionId,
              role: event.primary ? "root" : "worker",
              traceId: event.traceContext.traceId,
            },
          ],
    }));
  },
  async onEvalComplete(result) {
    const task = summarizeTaskResult(
      result,
      taskNames.get(result.id) ?? result.id
    );
    completedTasks.set(result.id, task);
    console.log(
      tableRow([
        task.name,
        task.success ? "SUCCESS" : "FAILURE",
        formatDuration(task.durationMs),
        formatCost(task.costUsd, task.costComplete),
        task.terminalMessage,
      ])
    );
    await updateLiveTask(result.id, (current) => ({
      ...current,
      completedAt: result.completedAt,
      costComplete: task.costComplete,
      costUsd: task.costUsd,
      durationMs: task.durationMs,
      error: task.error,
      judgeRationale: task.judgeRationale,
      judgeScore: task.judgeScore,
      status: task.success ? "passed" : failedTaskStatus(task.verdict),
      success: task.success,
      terminalMessage: task.terminalMessage,
      toolCalls: task.toolCalls,
      verdict: task.verdict,
    }));
  },
  async onRunComplete(summary) {
    console.log(tableBorder());
    const benchmark = await buildBenchmark(summary);
    const artifactPath = await writeBenchmark(benchmark);

    console.log(
      `Success ${String(benchmark.summary.passed)}/${String(benchmark.tasks.length)} | median ${formatOptionalDuration(benchmark.summary.medianDurationMs)} | p95 ${formatOptionalDuration(benchmark.summary.p95DurationMs)} | total LLM cost ${formatCost(benchmark.summary.totalCostUsd, benchmark.summary.costComplete)}`
    );
    console.log(`Benchmark saved to ${artifactPath}`);
    console.log("");
    await updateLiveVariant((current) => ({
      ...current,
      completedAt: summary.completedAt,
      status: "completed",
    }));
  },
};

export async function reportBrowserBenchmarkActivity(
  taskName: string,
  sessionId: string,
  events: readonly SessionStreamEvent[]
) {
  const activity = browserBenchmarkActivity(events);
  const activityDurationsMs = browserBenchmarkActivityDurations(events);
  const browserLiveViewUrl = browserBenchmarkLiveViewUrl(events);
  const durationSignature = JSON.stringify(activityDurationsMs);
  const activityChanged =
    activity !== null && liveActivities.get(taskName) !== activity;
  const durationsChanged =
    liveActivityDurations.get(taskName) !== durationSignature;
  const liveViewChanged =
    browserLiveViewUrl !== null &&
    liveViewUrls.get(taskName) !== browserLiveViewUrl;
  await writeLiveTrace(taskName, sessionId, events);
  if (!activityChanged && !durationsChanged && !liveViewChanged) return;
  if (activity !== null) liveActivities.set(taskName, activity);
  liveActivityDurations.set(taskName, durationSignature);
  if (browserLiveViewUrl !== null) {
    liveViewUrls.set(taskName, browserLiveViewUrl);
  }
  await updateLiveVariant((variant) => ({
    ...variant,
    tasks: variant.tasks.map((task) => {
      if (task.name !== taskName) return task;
      const updated = { ...task, activityDurationsMs };
      if (activity !== null) updated.activity = activity;
      if (browserLiveViewUrl !== null) {
        updated.browserLiveViewUrl = browserLiveViewUrl;
      }
      return updated;
    }),
  }));
}

async function writeLiveTrace(
  taskName: string,
  sessionId: string,
  events: readonly SessionStreamEvent[]
) {
  const config = liveStatusConfig();
  if (!config || !/^[A-Za-z0-9._:-]+$/u.test(sessionId)) return;
  const traceDirectory = join(dirname(config.path), config.runId, "traces");
  const tracePath = join(traceDirectory, `${sessionId}.json`);
  const temporaryPath = `${tracePath}.${String(process.pid)}.${randomUUID()}.tmp`;
  await mkdir(traceDirectory, { recursive: true });
  const view = foldEvents(emptySessionView(), events);
  await writeFile(
    temporaryPath,
    `${JSON.stringify(
      {
        events: events.flatMap((event) =>
          // Hooks never receive child.sent, so the trace timeline skips it.
          event.type === "child.sent"
            ? []
            : traceTimelineRows(event, {
                now: new Date(event.meta.at),
                position: event.meta.position,
                view,
              })
        ),
        sessionId,
        taskName,
        updatedAt: new Date().toISOString(),
        version: 1,
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await rename(temporaryPath, tracePath);
}

function summarizeTaskResult(result: EveEvalResult, name: string) {
  const metrics = measureWorkerTask(
    result.result.events,
    elapsedMs(result.startedAt, result.completedAt)
  );
  const fallbackMessage =
    result.result.reply ?? result.error ?? result.skipReason ?? "No reply";
  const workerSession = result.result.sessions
    ?.filter((session) => !session.primary)
    .toSorted((left, right) => right.events.length - left.events.length)
    .at(0);
  const workerEvents = workerSession?.events;
  const terminalMessage = terminalWorkerMessage(
    fallbackMessage,
    workerEvents ?? result.result.events
  );
  const workerFacts = workerSession ? [workerSession.derived] : [];
  const facts = workerFacts.length > 0 ? workerFacts : [result.result.derived];
  const calls = facts.flatMap((derived) => derived.toolCalls);
  const toolCalls = calls.reduce<Record<string, number>>((counts, call) => {
    counts[call.name] = (counts[call.name] ?? 0) + 1;
    return counts;
  }, {});
  const judge = result.assertions.find(
    (assertion) => assertion.name === "judge.boolean [task completed]"
  );
  const rationale = z.string().safeParse(judge?.metadata?.rationale);

  return {
    costComplete: metrics.costComplete,
    costUsd: metrics.costUsd,
    durationMs: metrics.durationMs,
    error: result.error ?? null,
    evalDurationMs: elapsedMs(result.startedAt, result.completedAt),
    failedToolCalls: calls.filter((call) => call.status === "failed").length,
    id: result.id,
    inputTokens: metrics.inputTokens,
    judgeRationale: rationale.success ? rationale.data : null,
    judgeScore: judge?.score ?? null,
    messageCount: facts.reduce(
      (count, derived) => count + derived.messageCount,
      0
    ),
    modelSteps: metrics.modelSteps,
    name,
    outputTokens: metrics.outputTokens,
    reasoningBlockCount: facts.reduce(
      (count, derived) => count + derived.reasoningBlockCount,
      0
    ),
    sessionId: result.result.sessionId ?? null,
    status: benchmarkTaskStatus(result.result.status),
    success: result.verdict === "passed",
    terminalMessage,
    toolCalls,
    verdict: result.verdict,
  };
}

function benchmarkTaskStatus(
  status: EveEvalResult["result"]["status"]
): BrowserBenchmark["tasks"][number]["status"] {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
    case "cancelled":
      return "failed";
    default:
      return "waiting";
  }
}

async function buildBenchmark(
  summary: EveEvalRunSummary
): Promise<BrowserBenchmark> {
  const tasks = summary.results.map(
    (result) =>
      completedTasks.get(result.id) ??
      summarizeTaskResult(result, taskNames.get(result.id) ?? result.id)
  );
  const successfulDurations = tasks
    .filter((task) => task.success)
    .map((task) => task.durationMs)
    .toSorted((left, right) => left - right);
  const measuredCosts = tasks.flatMap((task) =>
    task.costUsd === null ? [] : [task.costUsd]
  );
  const judgeScores = tasks.flatMap((task) =>
    task.judgeScore === null ? [] : [task.judgeScore]
  );
  const inputTokens = tasks.flatMap((task) =>
    task.inputTokens === null ? [] : [task.inputTokens]
  );
  const outputTokens = tasks.flatMap((task) =>
    task.outputTokens === null ? [] : [task.outputTokens]
  );
  const passed = tasks.filter((task) => task.success).length;
  const runtimeIdentity = summary.results.find(
    (result) => result.result.runtimeIdentity !== undefined
  )?.result.runtimeIdentity;
  const gitSha =
    runtimeIdentity?.build?.gitSha ?? (await readCurrentGitSha()) ?? null;
  const environmentLabel = browserBenchmarkEnv.BROWSER_BENCH_LABEL?.trim();

  return {
    completedAt: summary.completedAt,
    gitSha,
    label:
      environmentLabel && environmentLabel.length > 0
        ? environmentLabel
        : (gitSha?.slice(0, 12) ?? summary.startedAt),
    startedAt: summary.startedAt,
    summary: {
      costComplete:
        tasks.length > 0 && tasks.every((task) => task.costComplete),
      failed: tasks.filter((task) => !task.success).length,
      failedToolCalls: tasks.reduce(
        (count, task) => count + task.failedToolCalls,
        0
      ),
      meanJudgeScore:
        judgeScores.length === 0
          ? null
          : judgeScores.reduce((total, score) => total + score, 0) /
            judgeScores.length,
      medianDurationMs: percentile(successfulDurations, 0.5),
      passed,
      p95DurationMs: percentile(successfulDurations, 0.95),
      successRate: tasks.length === 0 ? 0 : passed / tasks.length,
      totalInputTokens:
        inputTokens.length === 0
          ? null
          : inputTokens.reduce((total, tokens) => total + tokens, 0),
      totalModelSteps: tasks.reduce(
        (count, task) => count + task.modelSteps,
        0
      ),
      totalOutputTokens:
        outputTokens.length === 0
          ? null
          : outputTokens.reduce((total, tokens) => total + tokens, 0),
      totalToolCalls: tasks.reduce(
        (count, task) =>
          count +
          Object.values(task.toolCalls).reduce(
            (taskCount, calls) => taskCount + calls,
            0
          ),
        0
      ),
      totalCostUsd:
        measuredCosts.length === 0
          ? null
          : measuredCosts.reduce((total, cost) => total + cost, 0),
    },
    target: {
      kind: summary.target.kind,
      url: summary.target.url,
    },
    tasks,
    version: 1,
  };
}

async function readCurrentGitSha() {
  try {
    const gitDirectory = join(process.cwd(), ".git");
    const head = (await readFile(join(gitDirectory, "HEAD"), "utf8")).trim();
    const referencePrefix = "ref: ";

    if (!head.startsWith(referencePrefix)) {
      return /^[0-9a-f]{40}$/u.test(head) ? head : undefined;
    }

    const reference = head.slice(referencePrefix.length);
    if (!/^refs\/[a-zA-Z0-9._/-]+$/u.test(reference)) return undefined;
    const sha = (await readFile(join(gitDirectory, reference), "utf8")).trim();
    return /^[0-9a-f]{40}$/u.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

async function writeBenchmark(benchmark: BrowserBenchmark) {
  const explicitPath = browserBenchmarkEnv.BROWSER_BENCH_ARTIFACT_PATH?.trim();
  const directory = explicitPath
    ? dirname(explicitPath)
    : join(process.cwd(), ".eve", "browser-benchmarks");
  const safeLabel = benchmark.label.replaceAll(/[^a-zA-Z0-9._-]/gu, "-");
  const timestamp = benchmark.startedAt.replaceAll(":", "-");
  const artifactPath =
    explicitPath ?? join(directory, `${timestamp}-${safeLabel}.json`);
  const serialized = `${JSON.stringify(benchmark, null, 2)}\n`;

  await mkdir(directory, { recursive: true });
  await writeFile(artifactPath, serialized, "utf8");
  if (!explicitPath) {
    await writeFile(join(directory, "latest.json"), serialized, "utf8");
  }

  return artifactPath;
}

function percentile(sortedValues: readonly number[], percentileValue: number) {
  if (sortedValues.length === 0) return null;
  const index = Math.ceil(sortedValues.length * percentileValue) - 1;
  return sortedValues[Math.max(0, index)] ?? null;
}

function elapsedMs(start: string, end: string) {
  return Math.max(0, new Date(end).getTime() - new Date(start).getTime());
}

function formatDuration(milliseconds: number) {
  return milliseconds < 1_000
    ? `${String(milliseconds)}ms`
    : `${(milliseconds / 1_000).toFixed(1)}s`;
}

function formatOptionalDuration(milliseconds: number | null) {
  return milliseconds === null ? "—" : formatDuration(milliseconds);
}

function formatCost(costUsd: number | null, complete: boolean) {
  if (costUsd === null) return "—";
  return `${complete ? "" : "~"}$${costUsd.toFixed(6)}`;
}

function tableBorder() {
  return `+${tableWidths.map((width) => "-".repeat(width + 2)).join("+")}+`;
}

function tableRow(values: readonly string[]) {
  const cells = tableWidths.map((width, index) => {
    const value = values[index] ?? "";
    const clipped =
      value.length > width
        ? `${value.slice(0, Math.max(0, width - 1))}…`
        : value;
    return ` ${clipped.padEnd(width)} `;
  });
  return `|${cells.join("|")}|`;
}

type LiveVariant = BrowserBenchmarkLiveStatus["variants"]["baseline"];
type LiveTask = LiveVariant["tasks"][number];

async function updateLiveVariant(
  update: (variant: LiveVariant) => LiveVariant
) {
  const config = liveStatusConfig();
  if (!config) return;
  await updateBrowserBenchmarkLiveStatus(
    config.path,
    config.runId,
    (status) => ({
      ...status,
      status: status.status === "preparing" ? "running" : status.status,
      variants: {
        ...status.variants,
        [config.variant]: update(status.variants[config.variant]),
      },
    })
  );
}

async function updateLiveTask(
  id: string,
  update: (task: LiveTask) => LiveTask
) {
  await updateLiveVariant((variant) => ({
    ...variant,
    tasks: variant.tasks.map((task) => (task.id === id ? update(task) : task)),
  }));
}

function liveStatusConfig() {
  const path = browserBenchmarkEnv.BROWSER_BENCH_STATUS_PATH?.trim();
  const runId = browserBenchmarkEnv.BROWSER_BENCH_RUN_ID?.trim();
  const variant = browserBenchmarkEnv.BROWSER_BENCH_VARIANT;
  return path && runId && variant ? { path, runId, variant } : null;
}

function failedTaskStatus(
  verdict: BrowserBenchmark["tasks"][number]["verdict"]
) {
  return verdict === "skipped" || verdict === "scored" ? verdict : "failed";
}

"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@web/components/ui/table";
import { ActivityDurationBreakdown } from "@web/components/browser/activity-duration-breakdown";
import type { BrowserBenchmarkLiveStatus } from "../../live-status-schema";
import {
  averageBenchmarkImprovement,
  compareBenchmarkTasks,
} from "../lib/benchmark-comparison";
import { useRuns } from "../lib/use-runs";

type Variant = BrowserBenchmarkLiveStatus["variants"]["baseline"];
type Task = Variant["tasks"][number];

export function RunDetail({ runId }: { runId: string }) {
  const { error, runs } = useRuns();
  const [now, setNow] = useState(() => Date.now());
  const run = runs.find((candidate) => candidate.runId === runId) ?? null;
  const active = run?.status === "preparing" || run?.status === "running";

  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1_000);
    return () => {
      clearInterval(timer);
    };
  }, [active]);

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-8">
      <header className="flex items-end justify-between gap-4">
        <div>
          <Link
            className="type-caption text-muted-foreground hover:text-foreground"
            href="/"
          >
            ← All runs
          </Link>
          <h1 className="type-page-title mt-3">
            {run?.label ?? "Browser A/B"}
          </h1>
          {run ? (
            <p className="type-supporting-body mt-1 text-muted-foreground">
              {run.suite} · {run.variants.baseline.sha.slice(0, 7)} →{" "}
              {run.variants.candidate.sha.slice(0, 7)}
            </p>
          ) : null}
        </div>
        {run ? <StatusText status={run.status} /> : null}
      </header>

      {error ? (
        <p className="type-supporting-body text-destructive">{error}</p>
      ) : null}
      {run?.error ? (
        <p className="type-supporting-body text-destructive">{run.error}</p>
      ) : null}
      {run ? (
        <RunTables now={now} run={run} />
      ) : (
        <p className="type-supporting-body text-muted-foreground">
          Loading run…
        </p>
      )}
    </main>
  );
}

function RunTables({
  now,
  run,
}: {
  now: number;
  run: BrowserBenchmarkLiveStatus;
}) {
  const baseline = run.variants.baseline.tasks;
  const candidate = run.variants.candidate.tasks;
  const averageImprovement = averageBenchmarkImprovement(baseline, candidate);
  const tasks = [
    ...baseline.map((task) => task.id),
    ...candidate
      .filter(
        (task) => !baseline.some((baselineTask) => baselineTask.id === task.id)
      )
      .map((task) => task.id),
  ];
  return (
    <>
      <div className="flex flex-wrap gap-x-5 gap-y-1 type-caption text-muted-foreground">
        <span>Concurrency {run.maxConcurrency}</span>
        <span>Task budget {formatDuration(run.taskTimeoutMs)}</span>
        <span>
          Wall {formatDuration(elapsed(run.startedAt, run.completedAt, now))}
        </span>
        <code>{run.runId}</code>
        <Improvement label="Mean time" value={averageImprovement.time} />
        <Improvement label="Mean cost" value={averageImprovement.cost} />
      </div>

      <div className="overflow-hidden border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Variant</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Revision</TableHead>
              <TableHead>Passed</TableHead>
              <TableHead>Running</TableHead>
              <TableHead>Failed</TableHead>
              <TableHead>Cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <VariantRow variant={run.variants.baseline} />
            <VariantRow variant={run.variants.candidate} />
          </TableBody>
        </Table>
      </div>

      <div>
        <h2 className="type-section-title mb-3">Tasks</h2>
        <div className="overflow-hidden border">
          <Table className="min-w-[1120px] table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[22%]">Task</TableHead>
                <TableHead className="w-[18%] border-l border-border">
                  Baseline result
                </TableHead>
                <TableHead className="w-[13%] border-l border-border">
                  Baseline trace
                </TableHead>
                <TableHead className="w-[18%] border-l border-border">
                  Candidate result
                </TableHead>
                <TableHead className="w-[13%] border-l border-border">
                  Candidate trace
                </TableHead>
                <TableHead className="w-[16%] border-l border-border">
                  Improvement
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tasks.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} variant="empty">
                    Preparing evaluations…
                  </TableCell>
                </TableRow>
              ) : (
                tasks.map((taskId) => {
                  const left = baseline.find((task) => task.id === taskId);
                  const right = candidate.find((task) => task.id === taskId);
                  return (
                    <TableRow className="border-b border-border" key={taskId}>
                      <TableCell className="align-top font-medium wrap-break-word whitespace-normal">
                        {left?.name ?? right?.name ?? "Task"}
                      </TableCell>
                      <TaskResultCell now={now} task={left} />
                      <TaskTraceCell
                        task={left}
                        traceHref={traceHref(run.runId, left)}
                      />
                      <TaskResultCell now={now} task={right} />
                      <TaskTraceCell
                        task={right}
                        traceHref={traceHref(run.runId, right)}
                      />
                      <TaskImprovement baseline={left} candidate={right} />
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      <p className="type-caption text-muted-foreground">
        Artifacts: <code>{run.outputDirectory}</code>
      </p>
    </>
  );
}

function VariantRow({ variant }: { variant: Variant }) {
  const summary = summarize(variant);
  return (
    <TableRow>
      <TableCell className="font-medium capitalize">{variant.kind}</TableCell>
      <TableCell>
        <StatusText status={variant.status} />
      </TableCell>
      <TableCell variant="code">
        {variant.ref} · {variant.sha.slice(0, 12)}
      </TableCell>
      <TableCell>
        {summary.passed}/{variant.tasks.length}
      </TableCell>
      <TableCell>{summary.running}</TableCell>
      <TableCell>{summary.failed}</TableCell>
      <TableCell>{formatCost(summary.cost, summary.costComplete)}</TableCell>
    </TableRow>
  );
}

function TaskResultCell({ now, task }: { now: number; task?: Task }) {
  if (!task)
    return <TableCell className="text-muted-foreground">Waiting</TableCell>;
  const message =
    task.terminalMessage ??
    task.error ??
    task.activity ??
    (task.status === "running" ? "Starting task" : "Waiting to start");
  return (
    <TableCell className="min-w-0 overflow-hidden border-l border-border align-top whitespace-normal">
      <div className="flex items-center gap-2">
        <StatusDot status={task.status} />
        <span className="type-compact-code text-muted-foreground">
          {formatDuration(
            task.durationMs ?? elapsed(task.startedAt, task.completedAt, now)
          )}
        </span>
      </div>
      <p
        className="mt-2 overflow-hidden type-caption text-ellipsis whitespace-nowrap"
        title={message}
      >
        {message}
      </p>
    </TableCell>
  );
}

function TaskTraceCell({
  task,
  traceHref: taskTraceHref,
}: {
  task?: Task;
  traceHref: string | null;
}) {
  if (!task) {
    return (
      <TableCell className="border-l border-border align-top text-muted-foreground">
        —
      </TableCell>
    );
  }
  return (
    <TableCell className="border-l border-border align-top whitespace-normal">
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {taskTraceHref ? (
          <a
            className="type-caption text-information hover:underline"
            href={taskTraceHref}
            rel="noreferrer"
            target="_blank"
          >
            Trace ↗
          </a>
        ) : null}
        {task.browserLiveViewUrl ? (
          <a
            className="type-caption text-information hover:underline"
            href={task.browserLiveViewUrl}
            rel="noreferrer"
            target="_blank"
          >
            Live browser ↗
          </a>
        ) : null}
      </div>
      <div className="mt-2">
        <ActivityDurationBreakdown durations={task.activityDurationsMs} />
      </div>
    </TableCell>
  );
}

function TaskImprovement({
  baseline,
  candidate,
}: {
  baseline: Task | undefined;
  candidate: Task | undefined;
}) {
  const improvement = compareBenchmarkTasks(baseline, candidate);
  return (
    <TableCell className="border-l border-border align-top whitespace-normal">
      <div className="grid gap-1">
        <Improvement label="Time" value={improvement.time} />
        <Improvement label="Cost" value={improvement.cost} />
      </div>
    </TableCell>
  );
}

function Improvement({
  label,
  value,
}: {
  label: string;
  value: number | null;
}) {
  if (value === null) {
    return (
      <span className="type-caption text-muted-foreground">{label} —</span>
    );
  }
  const improved = value < 0;
  return (
    <span
      className={`type-caption ${improved ? "text-success" : "text-destructive"}`}
      title="Candidate percentage change from baseline; lower is better"
    >
      {label} {value > 0 ? "+" : ""}
      {(value * 100).toFixed(1)}%
    </span>
  );
}

function traceHref(runId: string, task: Task | undefined) {
  const workerSession = task?.sessions.find(
    (session) => session.role === "worker"
  );
  return workerSession
    ? `/runs/${encodeURIComponent(runId)}/traces/${encodeURIComponent(workerSession.id)}`
    : null;
}

function StatusDot({ status }: { status: Task["status"] }) {
  const className =
    status === "passed"
      ? "bg-success"
      : status === "failed"
        ? "bg-destructive"
        : status === "scored" || status === "skipped"
          ? "bg-warning"
          : status === "running"
            ? "bg-information"
            : "bg-muted-foreground";
  return (
    <span
      aria-label={status}
      className={`size-2 shrink-0 rounded-full ${className}`}
      title={status}
    />
  );
}

function StatusText({ status }: { status: string }) {
  let className = "text-muted-foreground";
  if (status === "passed" || status === "completed") className = "text-success";
  if (status === "failed") className = "text-destructive";
  if (status === "scored" || status === "skipped") className = "text-warning";
  if (status === "running" || status === "preparing")
    className = "text-information";
  return <span className={className}>{status}</span>;
}

function summarize(variant: Variant) {
  let passed = 0;
  let running = 0;
  let failed = 0;
  let cost = 0;
  for (const task of variant.tasks) {
    if (task.success === true) passed += 1;
    if (task.status === "running") running += 1;
    if (task.success === false) failed += 1;
    cost += task.costUsd ?? 0;
  }
  return {
    cost,
    costComplete:
      variant.tasks.length > 0 &&
      variant.tasks.every((task) => task.costComplete),
    failed,
    passed,
    running,
  };
}

function elapsed(
  startedAt: string | null,
  completedAt: string | null,
  now: number
) {
  if (!startedAt) return null;
  return Math.max(
    0,
    (completedAt ? new Date(completedAt).getTime() : now) -
      new Date(startedAt).getTime()
  );
}

function formatDuration(milliseconds: number | null) {
  if (milliseconds === null) return "—";
  if (milliseconds < 1_000) return `${String(Math.round(milliseconds))}ms`;
  const seconds = milliseconds / 1_000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  return `${String(Math.floor(seconds / 60))}m ${String(Math.floor(seconds % 60))}s`;
}

function formatCost(cost: number | null, complete: boolean) {
  if (cost === null) return "—";
  return `${complete ? "" : "~"}$${cost.toFixed(4)}`;
}

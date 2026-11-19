"use client";

import Link from "next/link";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@web/components/ui/table";
import type { BrowserBenchmarkLiveStatus } from "../../../live-status-schema";
import { averageBenchmarkImprovement } from "../../lib/benchmark-comparison";
import { useRuns } from "../../lib/use-runs";

type Variant = BrowserBenchmarkLiveStatus["variants"]["baseline"];

export default function RunsPage() {
  const { error, runs } = useRuns();
  const active = runs.some(
    (run) => run.status === "preparing" || run.status === "running"
  );
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="type-page-title">Browser A/B runs</h1>
          <p className="type-supporting-body mt-1 text-muted-foreground">
            Current and completed comparisons.
          </p>
        </div>
        <span className="type-caption text-muted-foreground">
          {active ? "Running · " : ""}
          {runs.length} runs
        </span>
      </header>

      {error ? (
        <p className="type-supporting-body text-destructive">{error}</p>
      ) : null}

      <div className="overflow-hidden border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Run</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Suite</TableHead>
              <TableHead>Baseline</TableHead>
              <TableHead>Candidate</TableHead>
              <TableHead>Cost</TableHead>
              <TableHead>Wall</TableHead>
              <TableHead>Time</TableHead>
              <TableHead>Cost</TableHead>
              <TableHead aria-label="Open run" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.length === 0 ? (
              <TableRow>
                <TableCell colSpan={10} variant="empty">
                  No benchmark runs yet.
                </TableCell>
              </TableRow>
            ) : (
              runs.map((run) => <RunRow key={run.runId} run={run} />)
            )}
          </TableBody>
        </Table>
      </div>
    </main>
  );
}

function RunRow({ run }: { run: BrowserBenchmarkLiveStatus }) {
  const baseline = summarize(run.variants.baseline);
  const candidate = summarize(run.variants.candidate);
  const improvement = averageBenchmarkImprovement(
    run.variants.baseline.tasks,
    run.variants.candidate.tasks
  );
  return (
    <TableRow>
      <TableCell>
        <Link
          className="font-medium hover:underline"
          href={`/runs/${run.runId}`}
        >
          {run.label ?? formatRunDate(run.startedAt)}
        </Link>
        <div className="type-compact-code mt-0.5 text-muted-foreground">
          {run.label ? `${formatRunDate(run.startedAt)} · ` : ""}
          {run.variants.baseline.sha.slice(0, 7)} →{" "}
          {run.variants.candidate.sha.slice(0, 7)}
        </div>
      </TableCell>
      <TableCell>
        <RunStatus status={run.status} />
      </TableCell>
      <TableCell>{run.suite}</TableCell>
      <TableCell>{formatPassed(baseline)}</TableCell>
      <TableCell>{formatPassed(candidate)}</TableCell>
      <TableCell>
        {formatCost(
          baseline.cost + candidate.cost,
          baseline.costComplete && candidate.costComplete
        )}
      </TableCell>
      <TableCell>
        {formatDuration(elapsed(run.startedAt, run.completedAt))}
      </TableCell>
      <TableCell>
        <Improvement value={improvement.time} />
      </TableCell>
      <TableCell>
        <Improvement value={improvement.cost} />
      </TableCell>
      <TableCell>
        <Link
          className="text-muted-foreground hover:text-foreground"
          href={`/runs/${run.runId}`}
          aria-label="Open run"
        >
          →
        </Link>
      </TableCell>
    </TableRow>
  );
}

function Improvement({ value }: { value: number | null }) {
  if (value === null) return <span className="text-muted-foreground">—</span>;
  return (
    <span className={value < 0 ? "text-success" : "text-destructive"}>
      {value > 0 ? "+" : ""}
      {(value * 100).toFixed(1)}%
    </span>
  );
}

function RunStatus({
  status,
}: {
  status: BrowserBenchmarkLiveStatus["status"];
}) {
  const className =
    status === "failed"
      ? "text-destructive"
      : status === "completed"
        ? "text-success"
        : "text-information";
  return <span className={className}>{status}</span>;
}

function summarize(variant: Variant) {
  let passed = 0;
  let cost = 0;
  for (const task of variant.tasks) {
    if (task.success === true) passed += 1;
    cost += task.costUsd ?? 0;
  }
  return {
    cost,
    costComplete:
      variant.tasks.length > 0 &&
      variant.tasks.every((task) => task.costComplete),
    passed,
    total: variant.tasks.length,
  };
}

function formatPassed(summary: ReturnType<typeof summarize>) {
  return summary.total === 0
    ? "—"
    : `${String(summary.passed)}/${String(summary.total)}`;
}

function elapsed(startedAt: string, completedAt: string | null) {
  if (!completedAt) return null;
  return Math.max(
    0,
    new Date(completedAt).getTime() - new Date(startedAt).getTime()
  );
}

function formatDuration(milliseconds: number | null) {
  if (milliseconds === null) return "Running";
  const seconds = milliseconds / 1_000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  return `${String(Math.floor(seconds / 60))}m ${String(Math.floor(seconds % 60))}s`;
}

function formatCost(cost: number, complete: boolean) {
  return `${complete ? "" : "~"}$${cost.toFixed(4)}`;
}

function formatRunDate(value: string) {
  return new Date(value).toLocaleString([], {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
  });
}

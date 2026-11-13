"use client";

import type { EveToolPart } from "eve/react";
import {
  ArrowRightIcon,
  CheckCircle2Icon,
  CircleIcon,
  Trash2Icon,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

import {
  statsSchema,
  textAnalysisSchema,
} from "../../../../agent/lib/python-tools";
import type { Stats, TextAnalysis } from "../../../../agent/lib/python-tools";
import {
  deleteTaskOutputSchema,
  listTasksOutputSchema,
  taskSchema,
} from "../../../../agent/lib/tasks";
import type { Task } from "../../../../agent/lib/tasks";

/** Renders one tool's raw output as a card, or `undefined` if it is invalid. */
type CardRenderer = (output: unknown, toolName: string) => ReactNode | undefined;

const CARD_RENDERERS: Readonly<Record<string, CardRenderer>> = {
  analyze_text: (output) => {
    const parsed = textAnalysisSchema.safeParse(output);
    return parsed.success ? <TextAnalysisCard analysis={parsed.data} /> : undefined;
  },
  compute_stats: (output) => {
    const parsed = statsSchema.safeParse(output);
    return parsed.success ? <StatsCard stats={parsed.data} /> : undefined;
  },
  create_task: (output, toolName) => renderTask(output, toolName),
  delete_task: (output) => {
    const parsed = deleteTaskOutputSchema.safeParse(output);
    return parsed.success ? <DeletedTaskRow id={parsed.data.id} /> : undefined;
  },
  list_tasks: (output) => {
    const parsed = listTasksOutputSchema.safeParse(output);
    return parsed.success ? <TaskListCard tasks={parsed.data.tasks} /> : undefined;
  },
  update_task: (output, toolName) => renderTask(output, toolName),
};

/**
 * Renders a dedicated card for a finished tool call.
 *
 * @param part - The tool part from the message.
 * @returns The card, or `undefined` to fall back to the generic tool display.
 */
export function renderToolCard(part: EveToolPart): ReactNode | undefined {
  if (part.state !== "completed") {
    return undefined;
  }
  const render = CARD_RENDERERS[part.name];
  return render === undefined ? undefined : render(part.output, part.name);
}

const numberFormat = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 4,
});

/**
 * Formats a number for display.
 *
 * @param value - The number, or `null` when there is none.
 * @returns The formatted number, or an em dash for `null`.
 */
function formatNumber(value: number | null): string {
  return value === null ? "—" : numberFormat.format(value);
}

/**
 * Parses a task tool's output into a `TaskCard`.
 *
 * @param output - The raw tool output.
 * @param toolName - `create_task` or `update_task`.
 * @returns The card, or `undefined` when the output is not a task.
 */
function renderTask(output: unknown, toolName: string): ReactNode | undefined {
  const parsed = taskSchema.safeParse(output);
  return parsed.success ? (
    <TaskCard action={toolName === "create_task" ? "Created" : "Updated"} task={parsed.data} />
  ) : undefined;
}

/**
 * A compact card shell shared by every tool card.
 *
 * @param props - The component props.
 * @returns The card.
 */
function ToolCard({
  badge,
  children,
  footer,
  title,
}: {
  /** Shown at the right of the header. */
  readonly badge?: ReactNode;
  /** The card body. */
  readonly children: ReactNode;
  /** Optional footer content. */
  readonly footer?: ReactNode;
  /** The card title. */
  readonly title: ReactNode;
}) {
  return (
    <Card className="w-full gap-3 py-4 shadow-none">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">{title}</CardTitle>
        {badge === undefined ? null : <CardAction>{badge}</CardAction>}
      </CardHeader>
      <CardContent className="px-4">{children}</CardContent>
      {footer === undefined ? null : (
        <CardFooter className="px-4">{footer}</CardFooter>
      )}
    </Card>
  );
}

/**
 * One labelled number in a metric grid.
 *
 * @param props - The component props.
 * @returns The metric.
 */
function Metric({
  label,
  value,
}: {
  /** What the number measures. */
  readonly label: string;
  /** The number, already formatted. */
  readonly value: string;
}) {
  return (
    <div className="space-y-0.5">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="text-lg font-semibold tracking-tight tabular-nums">
        {value}
      </p>
    </div>
  );
}

/**
 * The `list_tasks` result: a read-only list linking to the Tasks page.
 *
 * @param props - The component props.
 * @returns The card.
 */
function TaskListCard({
  tasks,
}: {
  /** The tasks to list. */
  readonly tasks: readonly Task[];
}) {
  const done = tasks.filter((task) => task.completed).length;
  const open = tasks.length - done;
  return (
    <ToolCard
      badge={
        <Badge variant="secondary">
          {open} open · {done} done
        </Badge>
      }
      footer={
        <Button asChild size="sm" variant="outline">
          <Link href="/tasks">
            Open Tasks page
            <ArrowRightIcon />
          </Link>
        </Button>
      }
      title="Tasks"
    >
      {tasks.length === 0 ? (
        <p className="text-muted-foreground text-sm">No tasks.</p>
      ) : (
        <ul className="divide-y rounded-lg border text-sm">
          {tasks.map((task) => (
            <li className="flex items-start gap-2.5 px-3 py-2" key={task.id}>
              <TaskStatusIcon completed={task.completed} />
              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    "truncate",
                    task.completed && "text-muted-foreground line-through"
                  )}
                >
                  {task.title}
                </p>
                {task.notes === null || task.notes === "" ? null : (
                  <p className="text-muted-foreground truncate text-xs">
                    {task.notes}
                  </p>
                )}
              </div>
              <span className="text-muted-foreground shrink-0 font-mono text-xs">
                #{task.id}
              </span>
            </li>
          ))}
        </ul>
      )}
    </ToolCard>
  );
}

/**
 * A read-only completion indicator.
 *
 * @param props - The component props.
 * @returns The icon.
 */
function TaskStatusIcon({
  completed,
}: {
  /** Whether the task is done. */
  readonly completed: boolean;
}) {
  return completed ? (
    <CheckCircle2Icon
      aria-label="Completed"
      className="text-success mt-0.5 size-4 shrink-0"
    />
  ) : (
    <CircleIcon
      aria-label="Open"
      className="text-muted-foreground mt-0.5 size-4 shrink-0"
    />
  );
}

/**
 * The `create_task` / `update_task` result.
 *
 * @param props - The component props.
 * @returns The card.
 */
function TaskCard({
  action,
  task,
}: {
  /** What happened to the task. */
  readonly action: "Created" | "Updated";
  /** The task as the backend returned it. */
  readonly task: Task;
}) {
  return (
    <ToolCard
      badge={<Badge variant="secondary">{action}</Badge>}
      title={
        <span className="flex items-center gap-2">
          <TaskStatusIcon completed={task.completed} />
          <span
            className={cn(
              "min-w-0 break-words",
              task.completed && "text-muted-foreground line-through"
            )}
          >
            {task.title}
          </span>
        </span>
      }
    >
      <div className="space-y-2">
        {task.notes === null || task.notes === "" ? null : (
          <p className="text-muted-foreground text-sm whitespace-pre-wrap">
            {task.notes}
          </p>
        )}
        <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
          <Badge
            className={cn(task.completed && "text-success")}
            variant="outline"
          >
            {task.completed ? "Completed" : "Open"}
          </Badge>
          <span className="font-mono">#{task.id}</span>
          <span aria-hidden="true">·</span>
          <time dateTime={task.updated_at}>
            Updated {new Date(task.updated_at).toLocaleString()}
          </time>
        </div>
      </div>
    </ToolCard>
  );
}

/**
 * The `delete_task` result.
 *
 * @param props - The component props.
 * @returns The row.
 */
function DeletedTaskRow({
  id,
}: {
  /** The deleted task's id. */
  readonly id: number;
}) {
  return (
    <div className="text-muted-foreground flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-sm">
      <Trash2Icon className="text-destructive size-4 shrink-0" />
      <span>
        Deleted task <span className="font-mono">#{id}</span>
      </span>
    </div>
  );
}

/**
 * The `compute_stats` result: descriptive statistics as a metric grid.
 *
 * @param props - The component props.
 * @returns The card.
 */
export function StatsCard({
  stats,
}: {
  /** The statistics to show. */
  readonly stats: Stats;
}) {
  const metrics: readonly { readonly label: string; readonly value: number | null }[] = [
    { label: "Count", value: stats.count },
    { label: "Mean", value: stats.mean },
    { label: "Median", value: stats.median },
    { label: "Std dev", value: stats.stdev },
    { label: "Min", value: stats.min },
    { label: "Max", value: stats.max },
    { label: "Range", value: stats.range },
    { label: "Sum", value: stats.sum },
  ];
  return (
    <ToolCard title="Statistics">
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          {metrics.map(({ label, value }) => (
            <Metric key={label} label={label} value={formatNumber(value)} />
          ))}
        </div>
        {stats.modes.length > 0 || stats.quartiles !== null ? (
          <dl className="divide-y rounded-lg border text-sm">
            {stats.modes.length > 0 ? (
              <div className="flex gap-4 px-3 py-2">
                <dt className="text-muted-foreground w-1/3 shrink-0">
                  {stats.modes.length === 1 ? "Mode" : "Modes"}
                </dt>
                <dd className="min-w-0 flex-1 tabular-nums">
                  {stats.modes.map((mode) => formatNumber(mode)).join(", ")}
                </dd>
              </div>
            ) : null}
            {stats.quartiles === null ? null : (
              <div className="flex gap-4 px-3 py-2">
                <dt className="text-muted-foreground w-1/3 shrink-0">
                  Quartiles
                </dt>
                <dd className="min-w-0 flex-1 tabular-nums">
                  {stats.quartiles
                    .map((q, index) => `Q${index + 1} ${formatNumber(q)}`)
                    .join(" · ")}
                </dd>
              </div>
            )}
          </dl>
        ) : null}
      </div>
    </ToolCard>
  );
}

/**
 * Maps a Flesch reading-ease score to a readability band.
 *
 * @param score - The Flesch reading-ease score.
 * @returns The band label and text color.
 */
function readabilityBand(score: number): {
  readonly className: string;
  readonly label: string;
} {
  // Bands follow the standard Flesch reading-ease scale.
  if (score >= 70) {
    return { className: "text-success", label: "Easy" };
  }
  if (score >= 50) {
    return { className: "text-warning", label: "Moderate" };
  }
  if (score >= 30) {
    return { className: "text-destructive", label: "Difficult" };
  }
  return { className: "text-destructive", label: "Very difficult" };
}

/**
 * The `analyze_text` result: counts, readability, and top words.
 *
 * @param props - The component props.
 * @returns The card.
 */
function TextAnalysisCard({
  analysis,
}: {
  /** The analysis to show. */
  readonly analysis: TextAnalysis;
}) {
  const band = readabilityBand(analysis.flesch_reading_ease);
  const maxCount = Math.max(1, ...analysis.top_words.map(({ count }) => count));
  const metrics: readonly { readonly label: string; readonly value: number }[] = [
    { label: "Words", value: analysis.words },
    { label: "Unique words", value: analysis.unique_words },
    { label: "Sentences", value: analysis.sentences },
    { label: "Paragraphs", value: analysis.paragraphs },
    { label: "Reading time (min)", value: analysis.reading_time_minutes },
    { label: "Flesch score", value: analysis.flesch_reading_ease },
  ];
  return (
    <ToolCard
      badge={
        <Badge className={band.className} variant="outline">
          {band.label} to read
        </Badge>
      }
      title="Text analysis"
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
          {metrics.map(({ label, value }) => (
            <Metric key={label} label={label} value={formatNumber(value)} />
          ))}
        </div>
        {analysis.top_words.length === 0 ? null : (
          <div className="space-y-1.5">
            <p className="text-muted-foreground text-xs">Top words</p>
            <ul className="space-y-1">
              {analysis.top_words.map(({ count, word }) => (
                <li className="flex items-center gap-2 text-sm" key={word}>
                  <span className="w-24 shrink-0 truncate">{word}</span>
                  <div className="bg-muted h-2 flex-1 overflow-hidden rounded-full">
                    <div
                      className="bg-primary h-full rounded-full"
                      style={{ width: `${(count / maxCount) * 100}%` }}
                    />
                  </div>
                  <span className="text-muted-foreground w-8 shrink-0 text-right text-xs tabular-nums">
                    {count}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </ToolCard>
  );
}

import { AlertCircleIcon, ListTodoIcon } from "lucide-react";
import { connection } from "next/server";
import { Suspense } from "react";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { BackendError, backendJson, type Task } from "@/lib/backend";
import { NewTaskForm, TaskList } from "./task-forms";

export const metadata = { title: "Tasks · eve Agent with Python" };

export const instant = true;

export default function TasksPage() {
  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8">
      <PageHeader title="Tasks">
        Stored by the FastAPI <code className="font-mono text-xs">/v1/tasks</code> API (Postgres
        in production, SQLite locally). Ask the agent on the Chat page to add, complete, or delete
        tasks too.
      </PageHeader>

      <Card className="gap-0 py-0">
        <CardContent className="border-b py-4">
          <NewTaskForm />
        </CardContent>
        <Suspense fallback={<TaskListSkeleton />}>
          <Tasks />
        </Suspense>
      </Card>
    </main>
  );
}

const PAGE_SIZE = 200; // FastAPI's maximum `limit`.
const MAX_TASKS = 1000;

/**
 * Pages through `/v1/tasks` so the list and its All / Open / Done counts cover
 * every task, up to {@link MAX_TASKS}.
 */
async function fetchTasks(): Promise<{ tasks: Task[]; truncated: boolean }> {
  const tasks: Task[] = [];
  while (tasks.length < MAX_TASKS) {
    const page = await backendJson<Task[]>(`/v1/tasks?limit=${PAGE_SIZE}&offset=${tasks.length}`);
    tasks.push(...page);
    if (page.length < PAGE_SIZE) {
      return { tasks, truncated: false };
    }
  }
  // Exactly MAX_TASKS fills every page; only report truncation if more exist.
  const more = await backendJson<Task[]>(`/v1/tasks?limit=1&offset=${MAX_TASKS}`);
  return { tasks, truncated: more.length > 0 };
}

/** Fetched per request, so the list streams in after the page shell and form. */
async function Tasks() {
  await connection();

  let tasks: Task[];
  let truncated: boolean;
  try {
    ({ tasks, truncated } = await fetchTasks());
  } catch (cause) {
    const status = cause instanceof BackendError ? cause.status : 0;
    const message = cause instanceof Error ? cause.message : String(cause);
    return (
      <div className="flex items-start gap-3 p-6 text-sm text-destructive">
        <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
        <p>
          {status === 503
            ? `The database isn't configured yet: ${message}`
            : `Could not load tasks: ${message}`}
        </p>
      </div>
    );
  }

  if (tasks.length === 0) {
    return (
      <div className="p-6">
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          <ListTodoIcon className="size-5" />
          No tasks yet.
        </div>
      </div>
    );
  }

  return (
    <>
      <TaskList tasks={tasks} />
      {truncated ? (
        <p className="border-t px-6 py-3 text-xs text-muted-foreground">
          Showing the first {MAX_TASKS} tasks (open tasks first).
        </p>
      ) : null}
    </>
  );
}

function TaskListSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading tasks">
      <div className="flex items-center gap-1 border-b px-4 py-2">
        {["w-12", "w-16", "w-16"].map((width, index) => (
          <Skeleton className={`h-7 ${width}`} key={index} />
        ))}
      </div>
      <ul className="divide-y">
        {["w-1/2", "w-1/3", "w-3/5"].map((width) => (
          <li className="flex h-[47px] items-center gap-3 px-6" key={width}>
            <Skeleton className="size-4 rounded-[4px]" />
            <Skeleton className={`h-4 ${width}`} />
          </li>
        ))}
      </ul>
    </div>
  );
}

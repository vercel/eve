"use client";

import { PlusIcon, Trash2Icon } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useActionState, useOptimistic, useRef, useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import type { Task } from "@/lib/backend";
import { cn } from "@/lib/utils";
import { createTask, deleteTask, setTaskCompleted, type TaskFormState } from "./actions";

export function NewTaskForm() {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, action, pending] = useActionState<TaskFormState, FormData>(
    async (previous, formData) => {
      const next = await createTask(previous, formData);
      if (!next.error) {
        formRef.current?.reset();
      }
      return next;
    },
    {},
  );

  return (
    <form action={action} className="space-y-2" ref={formRef}>
      <div className="flex gap-2">
        <Label className="sr-only" htmlFor="task-title">
          Task title
        </Label>
        <Input
          className="flex-1"
          id="task-title"
          maxLength={200}
          name="title"
          placeholder="Add a task…"
          required
        />
        <Button disabled={pending} type="submit">
          {pending ? <Spinner /> : <PlusIcon />}
          {pending ? "Adding…" : "Add"}
        </Button>
      </div>
      <Label className="sr-only" htmlFor="task-notes">
        Notes
      </Label>
      <Textarea
        className="min-h-0 resize-none field-sizing-fixed"
        id="task-notes"
        maxLength={2000}
        name="notes"
        placeholder="Notes (optional)"
        rows={2}
      />
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
    </form>
  );
}

const FILTERS = [
  { key: "all", label: "All", empty: "No tasks yet." },
  { key: "open", label: "Open", empty: "No open tasks." },
  { key: "done", label: "Done", empty: "Nothing done yet." },
] as const;

type Filter = (typeof FILTERS)[number]["key"];

/** Reads `?status=open|done`; anything else means all tasks. */
function parseFilter(value: string | null): Filter {
  return value === "open" || value === "done" ? value : "all";
}

function matchesFilter(task: Task, filter: Filter) {
  return filter === "all" || task.completed === (filter === "done");
}

/**
 * The task list with All / Open / Done filters, each showing its count. The
 * filter lives in the URL (`/tasks?status=open`), so it survives a reload and
 * can be shared.
 */
export function TaskList({ tasks }: { readonly tasks: readonly Task[] }) {
  const searchParams = useSearchParams();
  const filter = parseFilter(searchParams.get("status"));

  const setFilter = (next: Filter) => {
    const params = new URLSearchParams(searchParams);
    if (next === "all") {
      params.delete("status");
    } else {
      params.set("status", next);
    }
    const query = params.toString();
    // Next syncs useSearchParams with native history updates, without refetching the page.
    window.history.replaceState(null, "", query === "" ? "/tasks" : `/tasks?${query}`);
  };
  const visible = tasks.filter((task) => matchesFilter(task, filter));

  return (
    <>
      <div
        aria-label="Filter tasks"
        className="flex items-center gap-1 border-b px-4 py-2"
        role="group"
      >
        {FILTERS.map(({ key, label }) => {
          const active = key === filter;
          const count = tasks.filter((task) => matchesFilter(task, key)).length;
          return (
            <button
              aria-pressed={active}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                active && "bg-muted text-foreground",
              )}
              key={key}
              onClick={() => setFilter(key)}
              type="button"
            >
              {label}
              <span className="text-xs text-muted-foreground tabular-nums">{count}</span>
            </button>
          );
        })}
      </div>
      {visible.length === 0 ? (
        <p className="px-6 py-8 text-center text-sm text-muted-foreground">
          {FILTERS.find(({ key }) => key === filter)?.empty}
        </p>
      ) : (
        <ul className="divide-y">
          {visible.map((task) => (
            <TaskRow key={task.id} task={task} />
          ))}
        </ul>
      )}
    </>
  );
}

export function TaskRow({ task }: { readonly task: Task }) {
  const [pending, startTransition] = useTransition();
  const [completed, setOptimisticCompleted] = useOptimistic(task.completed);
  const [error, setError] = useState<string>();

  // Actions return `{ error }` rather than throwing, so a failure (e.g. the agent
  // already deleted this task) shows inline instead of crashing the page.
  // useOptimistic reverts the checkbox on its own when the transition ends.
  const run = (action: () => Promise<TaskFormState>) => {
    setError(undefined);
    startTransition(async () => {
      const result = await action();
      if (result.error) {
        setError(result.error);
      }
    });
  };

  return (
    <li
      className={cn(
        "flex items-start gap-3 px-6 py-3 transition-opacity",
        pending && "opacity-60",
      )}
    >
      <Checkbox
        aria-label={completed ? `Reopen ${task.title}` : `Complete ${task.title}`}
        checked={completed}
        className="mt-0.5"
        disabled={pending}
        onCheckedChange={(value) => {
          const next = value === true;
          run(() => {
            setOptimisticCompleted(next);
            return setTaskCompleted(task.id, next);
          });
        }}
      />
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "text-sm leading-5 break-words",
            completed && "text-muted-foreground line-through",
          )}
        >
          {task.title}
        </p>
        {task.notes ? (
          <p className="mt-0.5 text-xs whitespace-pre-wrap text-muted-foreground">{task.notes}</p>
        ) : null}
        {error ? (
          <p className="mt-0.5 text-xs text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <Badge className="font-mono text-muted-foreground" variant="outline">
        #{task.id}
      </Badge>
      <Button
        aria-label={`Delete ${task.title}`}
        className="-my-1.5 text-muted-foreground hover:text-destructive"
        disabled={pending}
        onClick={() => run(() => deleteTask(task.id))}
        size="icon-sm"
        type="button"
        variant="ghost"
      >
        <Trash2Icon />
      </Button>
    </li>
  );
}

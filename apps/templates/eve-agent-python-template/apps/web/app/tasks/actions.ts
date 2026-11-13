"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { backendJson } from "@/lib/backend";
import { hasAccess } from "@/lib/session";
import { taskIdSchema } from "../../../../agent/lib/tasks";

// Server Actions call FastAPI directly over the service binding; the browser
// never talks to the backend. Actions are reachable by id from any route, so
// each one checks access itself rather than relying on `proxy.ts` alone.
// Arguments come from the client: validate them, since TypeScript types don't exist at runtime.

export type TaskFormState = { error?: string };

const SESSION_EXPIRED = "Your session has expired. Sign in again.";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

export async function createTask(_state: TaskFormState, formData: FormData): Promise<TaskFormState> {
  if (!(await hasAccess())) {
    return { error: SESSION_EXPIRED };
  }

  const title = String(formData.get("title") ?? "").trim();
  const notes = String(formData.get("notes") ?? "").trim();
  if (!title) {
    return { error: "Give the task a title." };
  }

  try {
    await backendJson("/v1/tasks", { method: "POST", json: { title, notes: notes || null } });
  } catch (error) {
    return { error: errorMessage(error) };
  }
  revalidatePath("/tasks");
  return {};
}

const setCompletedInput = z.tuple([taskIdSchema, z.boolean()]);

export async function setTaskCompleted(id: number, completed: boolean): Promise<TaskFormState> {
  if (!(await hasAccess())) {
    return { error: SESSION_EXPIRED };
  }
  const input = setCompletedInput.safeParse([id, completed]);
  if (!input.success) {
    return { error: "Invalid task." };
  }

  try {
    await backendJson(`/v1/tasks/${input.data[0]}`, {
      method: "PATCH",
      json: { completed: input.data[1] },
    });
  } catch (error) {
    return { error: errorMessage(error) };
  } finally {
    // Refresh even on failure, e.g. so a task deleted elsewhere drops out of the list.
    revalidatePath("/tasks");
  }
  return {};
}

export async function deleteTask(id: number): Promise<TaskFormState> {
  if (!(await hasAccess())) {
    return { error: SESSION_EXPIRED };
  }
  const taskId = taskIdSchema.safeParse(id);
  if (!taskId.success) {
    return { error: "Invalid task." };
  }

  try {
    await backendJson(`/v1/tasks/${taskId.data}`, { method: "DELETE" });
  } catch (error) {
    return { error: errorMessage(error) };
  } finally {
    revalidatePath("/tasks");
  }
  return {};
}

import { z } from "zod";

// Imported by apps/web client code (chat tool cards): keep this module free of
// eve runtime, backend, and Node-only imports.

// Mirrors TaskRead in apps/api/models/task.py.
export const taskSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  notes: z.string().nullable(),
  completed: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type Task = z.infer<typeof taskSchema>;

export const taskIdSchema = z.number().int().positive().describe("The task's numeric id.");
export const taskTitleSchema = z.string().trim().min(1).max(200);
export const taskNotesSchema = z.string().max(2000);

export const listTasksOutputSchema = z.object({ tasks: z.array(taskSchema) });
export type ListTasksOutput = z.infer<typeof listTasksOutputSchema>;

export const deleteTaskOutputSchema = z.object({ deleted: z.literal(true), id: z.number().int() });
export type DeleteTaskOutput = z.infer<typeof deleteTaskOutputSchema>;

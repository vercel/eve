import { z } from "zod";

export const taskStates = [
  "TASK_STATE_SUBMITTED",
  "TASK_STATE_WORKING",
  "TASK_STATE_INPUT_REQUIRED",
  "TASK_STATE_AUTH_REQUIRED",
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
] as const;
export const taskSchema = z.object({
  id: z.string(),
  contextId: z.string(),
  status: z.object({
    state: z.enum(taskStates),
    timestamp: z.string().optional(),
    message: z.unknown().optional(),
  }),
  artifacts: z.array(z.object({ artifactId: z.string(), parts: z.array(z.unknown()) })).optional(),
});
export type Task = z.infer<typeof taskSchema>;
export type TaskState = Task["status"]["state"];

export function terminal(task: Task): boolean {
  return [
    "TASK_STATE_COMPLETED",
    "TASK_STATE_FAILED",
    "TASK_STATE_CANCELED",
    "TASK_STATE_REJECTED",
  ].includes(task.status.state);
}

export function interrupted(task: Task): boolean {
  return (
    task.status.state === "TASK_STATE_INPUT_REQUIRED" ||
    task.status.state === "TASK_STATE_AUTH_REQUIRED"
  );
}

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export const rpcRequest = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  method: z.string(),
  params: z.unknown().optional(),
});

export const sendRequest = z.object({
  message: z.object({
    messageId: z.string().min(1),
    role: z.literal("ROLE_USER"),
    parts: z.array(z.object({ text: z.string() }).strict()).min(1),
    taskId: z.string().optional(),
    contextId: z.string().optional(),
  }),
  configuration: z.object({ returnImmediately: z.boolean().optional() }).optional(),
});

export const taskRequest = z.object({
  id: z.string().min(1),
  historyLength: z.number().int().nonnegative().optional(),
});

export function success(id: string | number, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id, result });
}

export function failure(id: string | number | null, error: unknown): Response {
  const known = error instanceof RpcError;
  if (!known && !(error instanceof z.ZodError)) console.error(error);
  return Response.json({
    jsonrpc: "2.0",
    id,
    error: {
      code: known ? error.code : error instanceof z.ZodError ? -32602 : -32603,
      message: known
        ? error.message
        : error instanceof z.ZodError
          ? "Invalid parameters"
          : "Internal error",
    },
  });
}

import { z } from "#compiled/zod/index.js";

import { conforming, envelopeOf, errorInfo, id, known } from "../common.js";
import type { Envelope, ErrorInfo } from "../envelope.js";

export interface TaskStartedData {
  readonly taskId: string;
  /** The call that started the task; it also gets `call.started {taskId}`. */
  readonly startedBy: { readonly callId: string };
  /** `agent` for a subagent, `tool` for an authored tool. Open. */
  readonly kind: "agent" | "tool" | (string & {});
  readonly name: string;
}

export type TaskOutcome = "completed" | "failed" | "cancelled";

export interface TaskEndedData {
  readonly taskId: string;
  readonly outcome: TaskOutcome;
  /** Open: why a task was cancelled, such as `task-cancel`, `turn-cancelled`, or `session-ended`. */
  readonly reason?: string;
  readonly error?: ErrorInfo;
}

export type TaskStarted = Envelope<"task.started", TaskStartedData>;
/** A task ends once; individual calls it serves settle separately with `call.settled`. */
export type TaskEnded = Envelope<"task.ended", TaskEndedData>;
export type TaskFact = TaskStarted | TaskEnded;

export const taskSchemas = {
  "task.ended": envelopeOf(
    "task.ended",
    conforming<TaskEndedData>()(
      z.object({
        error: errorInfo.optional(),
        outcome: known<TaskOutcome>(),
        reason: z.string().optional(),
        taskId: id,
      }),
    ),
  ),
  "task.started": envelopeOf(
    "task.started",
    conforming<TaskStartedData>()(
      z.object({
        kind: z.string(),
        name: z.string(),
        startedBy: z.object({ callId: id }),
        taskId: id,
      }),
    ),
  ),
};

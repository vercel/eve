import { z } from "#compiled/zod/index.js";

import { conforming, envelopeOf, errorInfo, id, known } from "../common.js";
import type { Envelope, ErrorInfo } from "../envelope.js";

/** The payload of `task.started`: a call started a task, such as a subagent or an authored tool. */
export interface TaskStartedData {
  readonly taskId: string;
  /** The call that started the task; it also gets `call.started {taskId}`. */
  readonly startedBy: { readonly callId: string };
  /** `agent` for a subagent, `tool` for an authored tool. Open. */
  readonly kind: "agent" | "tool" | (string & {});
  readonly name: string;
}

/** How a task ended, as recorded on `task.ended`. */
export type TaskOutcome = "completed" | "failed" | "cancelled";

/** The payload of `task.ended`: a task ends, with its outcome. */
export interface TaskEndedData {
  readonly taskId: string;
  readonly outcome: TaskOutcome;
  /** Open: why a task was cancelled, such as `task-cancel`, `turn-cancelled`, or `session-ended`. */
  readonly reason?: string;
  readonly error?: ErrorInfo;
}

/** The fact that introduces a task. */
export type TaskStarted = Envelope<"task.started", TaskStartedData>;
/** A task ends once; individual calls it serves settle separately with `call.settled`. */
export type TaskEnded = Envelope<"task.ended", TaskEndedData>;
/** Any fact in the `task` family. */
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

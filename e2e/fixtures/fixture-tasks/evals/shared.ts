import type { EveEvalContext, EveEvalSession, EveEvalTurn, InputRequest } from "eve/evals";
import { satisfies } from "eve/evals/expect";

export type TaskEvalSessionDriver = Pick<
  EveEvalSession,
  "pendingInputRequests" | "respond" | "send" | "sessionId" | "state"
>;

export interface PendingTaskInput {
  readonly observedTurns: readonly EveEvalTurn[];
  readonly request: InputRequest;
  readonly session: TaskEvalSessionDriver;
}

export interface FollowedQueuedTurn {
  readonly observedTurns: readonly EveEvalTurn[];
  readonly session: TaskEvalSessionDriver;
  readonly turn: EveEvalTurn;
}

interface FollowQueuedTurnOptions {
  readonly allowFailedActions?: boolean;
}

export function requireSessionStreamIndex(
  session: TaskEvalSessionDriver,
  operation: string,
): number {
  const state = session.state;
  if (state === undefined) throw new Error(`${operation} has no session state.`);
  return state.streamIndex;
}

/** Waits across server-initiated parent turns for one task-owned input request. */
export async function waitForTaskInput(
  t: EveEvalContext,
  initialSession: TaskEvalSessionDriver,
  toolName: string,
): Promise<PendingTaskInput> {
  let session = initialSession;
  const observedTurns: EveEvalTurn[] = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const matching = session.pendingInputRequests.filter(
      (request) => request.action.toolName === toolName,
    );
    if (matching.length > 1) {
      throw new Error(`Task surfaced ${matching.length} pending requests for tool "${toolName}".`);
    }
    if (matching[0] !== undefined) {
      if (session.pendingInputRequests.length !== 1) {
        throw new Error(
          `Task surfaced unexpected pending input alongside tool "${toolName}": ${session.pendingInputRequests
            .map((request) => request.action.toolName)
            .join(", ")}.`,
        );
      }
      return { observedTurns, request: matching[0], session };
    }
    if (session.pendingInputRequests.length > 0) {
      throw new Error(
        `Expected task input for tool "${toolName}"; received ${session.pendingInputRequests
          .map((request) => request.action.toolName)
          .join(", ")}.`,
      );
    }

    const sessionId = session.sessionId;
    if (sessionId === undefined) throw new Error("Task input wait has no parent session id.");
    const live = t.target.watchTurn(sessionId, {
      startIndex: requireSessionStreamIndex(session, "Task input wait"),
    });
    const turn = await live.result();
    turn.noFailedActions().label(`task input wait ${attempt + 1} has no failed actions`);
    observedTurns.push(turn);
    session = live.session;
  }
  throw new Error(`Task did not surface input for tool "${toolName}" after five turns.`);
}

/** Reads the task receipt attached to a background `subagent.completed` event. */
export function requireBackgroundTaskId(turn: EveEvalTurn): string {
  for (const event of turn.events) {
    if (event.type === "subagent.completed" && event.data.backgroundTask !== undefined) {
      return event.data.backgroundTask.taskId;
    }
  }
  throw new Error("Turn completed without a background task receipt.");
}

export function parseToolErrorOutput(output: unknown): unknown {
  if (typeof output !== "string") return output;
  try {
    return JSON.parse(output);
  } catch {
    return output;
  }
}

/** Returns the exact model-visible task view from a task-control result. */
export function requireTaskView(output: unknown, taskId: string): Record<string, unknown> {
  if (output === null || typeof output !== "object") {
    throw new Error("Task control did not return an object.");
  }
  const tasks = Reflect.get(output, "tasks");
  if (!Array.isArray(tasks)) throw new Error("Task control did not return a tasks array.");
  const matches = tasks.filter(
    (candidate) =>
      candidate !== null &&
      typeof candidate === "object" &&
      Reflect.get(candidate, "taskId") === taskId,
  );
  if (matches.length !== 1) {
    throw new Error(`Task control returned ${matches.length} views for ${taskId}.`);
  }
  return matches[0] as Record<string, unknown>;
}

/** Follows queued server turns until the requested user message owns a turn. */
export async function sendAndFollowQueuedTurn(
  t: EveEvalContext,
  message: string,
  initialSession: TaskEvalSessionDriver = t,
  options: FollowQueuedTurnOptions = {},
): Promise<FollowedQueuedTurn> {
  let session = initialSession;
  let turn = await session.send(message);
  const observedTurns = [turn];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (options.allowFailedActions !== true) {
      turn.noFailedActions().label(`queued turn ${attempt + 1} has no failed actions`);
    }
    const received = turn.events.some(
      (event) =>
        event.type === "message.received" && messageText(event.data.message).includes(message),
    );
    if (received) return { observedTurns, session, turn };

    const sessionId = session.sessionId;
    if (sessionId === undefined) throw new Error("Queued turn follow-up has no session id.");
    const live = t.target.watchTurn(sessionId, {
      startIndex: requireSessionStreamIndex(session, "Queued turn follow-up"),
    });
    turn = await live.result();
    observedTurns.push(turn);
    session = live.session;
  }
  throw new Error(`Queued message "${message}" was not received after 20 turns.`);
}

/** Waits for completion, then reads the immutable terminal view through no-op cancellation. */
export async function waitForCompletedTask(
  t: EveEvalContext,
  session: TaskEvalSessionDriver,
  verificationMessage: string,
  taskId: string,
): Promise<EveEvalTurn> {
  return await waitForTaskStatus(t, session, verificationMessage, taskId, "completed");
}

/** Waits for a terminal status, then reads it through no-op cancellation. */
export async function waitForTaskStatus(
  t: EveEvalContext,
  session: TaskEvalSessionDriver,
  verificationMessage: string,
  taskId: string,
  status: string,
): Promise<EveEvalTurn> {
  let currentSession = session;
  const timeoutMs = 30_000;
  const deadline = performance.now() + timeoutMs;
  let attempt = 0;
  while (performance.now() < deadline) {
    const followed = await sendAndFollowQueuedTurn(
      t,
      `${verificationMessage} ${taskId}`,
      currentSession,
    );
    for (const [turnIndex, observed] of followed.observedTurns.entries()) {
      observed
        .noFailedActions()
        .label(`task status attempt ${attempt + 1}, turn ${turnIndex + 1} has no failed actions`);
    }
    const turn = followed.turn;
    currentSession = followed.session;
    const inspected = turn.toolCalls.find((call) => call.name === "task_cancel");
    if (taskStatus(inspected?.output, taskId) === status) {
      await t.require(
        inspected?.output,
        satisfies(
          (output) => taskStatus(output, taskId) === status,
          `task_cancel preserves ${status} task ${taskId}`,
        ),
      );
      return turn;
    }
    attempt += 1;
    await t.sleep(100);
  }
  throw new Error(
    `Task ${taskId} did not reach "${status}" within ${timeoutMs / 1_000} seconds (${attempt} verification attempts).`,
  );
}

function messageText(message: unknown): string {
  if (typeof message === "string") return message;
  if (!Array.isArray(message)) return "";
  return message
    .flatMap((part) =>
      part !== null &&
      typeof part === "object" &&
      Reflect.get(part, "type") === "text" &&
      typeof Reflect.get(part, "text") === "string"
        ? [Reflect.get(part, "text") as string]
        : [],
    )
    .join("\n");
}

function taskStatus(output: unknown, taskId: string): unknown {
  if (output === null || typeof output !== "object") return undefined;
  const tasks = Reflect.get(output, "tasks");
  if (!Array.isArray(tasks)) return undefined;
  const task = tasks.find(
    (candidate) =>
      candidate !== null &&
      typeof candidate === "object" &&
      Reflect.get(candidate, "taskId") === taskId,
  );
  return task === undefined ? undefined : Reflect.get(task, "status");
}

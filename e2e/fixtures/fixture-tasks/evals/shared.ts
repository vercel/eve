import type { EveEvalContext, EveEvalSession, EveEvalTurn, InputRequest } from "eve/evals";
import { satisfies } from "eve/evals/expect";

export type TaskEvalSessionDriver = Pick<
  EveEvalSession,
  "pendingInputRequests" | "respond" | "send" | "sessionId" | "state"
>;

export interface PendingTaskInput {
  readonly request: InputRequest;
  readonly session: TaskEvalSessionDriver;
}

export interface FollowedQueuedTurn {
  readonly observedTurns: readonly EveEvalTurn[];
  readonly session: TaskEvalSessionDriver;
  readonly turn: EveEvalTurn;
}

/** Waits across server-initiated parent turns for one task-owned input request. */
export async function waitForTaskInput(
  t: EveEvalContext,
  initialSession: TaskEvalSessionDriver,
  toolName: string,
): Promise<PendingTaskInput> {
  let session = initialSession;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const pending = session.pendingInputRequests.find(
      (request) => request.action.toolName === toolName,
    );
    if (pending !== undefined) return { request: pending, session };

    const sessionId = session.sessionId;
    if (sessionId === undefined) throw new Error("Task input wait has no parent session id.");
    const live = t.target.watchTurn(sessionId, { startIndex: session.state.streamIndex });
    await live.result();
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

/** Returns the exact model-visible task view for one owned task id. */
export function requireTaskView(output: unknown, taskId: string): Record<string, unknown> {
  if (output === null || typeof output !== "object") {
    throw new Error("task_peek did not return an object.");
  }
  const tasks = Reflect.get(output, "tasks");
  if (!Array.isArray(tasks)) throw new Error("task_peek did not return a tasks array.");
  const matches = tasks.filter(
    (candidate) =>
      candidate !== null &&
      typeof candidate === "object" &&
      Reflect.get(candidate, "taskId") === taskId,
  );
  if (matches.length !== 1) {
    throw new Error(`task_peek returned ${matches.length} views for ${taskId}.`);
  }
  return matches[0] as Record<string, unknown>;
}

/** Follows queued server turns until the requested user message owns a turn. */
export async function sendAndFollowQueuedTurn(
  t: EveEvalContext,
  message: string,
  initialSession: TaskEvalSessionDriver = t,
): Promise<FollowedQueuedTurn> {
  let session = initialSession;
  let turn = await session.send(message);
  const observedTurns = [turn];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const received = turn.events.some(
      (event) =>
        event.type === "message.received" && messageText(event.data.message).includes(message),
    );
    if (received) return { observedTurns, session, turn };

    const sessionId = session.sessionId;
    if (sessionId === undefined) throw new Error("Queued turn follow-up has no session id.");
    const live = t.target.watchTurn(sessionId, { startIndex: session.state.streamIndex });
    turn = await live.result();
    observedTurns.push(turn);
    session = live.session;
  }
  throw new Error(`Queued message "${message}" was not received after 20 turns.`);
}

/** Polls the non-blocking task view until the expected task is completed. */
export async function waitForCompletedTask(
  t: EveEvalContext,
  session: TaskEvalSessionDriver,
  verificationMessage: string,
  taskId: string,
): Promise<EveEvalTurn> {
  return await waitForTaskStatus(t, session, verificationMessage, taskId, "completed");
}

/** Polls the non-blocking task view until the expected task reaches `status`. */
export async function waitForTaskStatus(
  t: EveEvalContext,
  session: TaskEvalSessionDriver,
  verificationMessage: string,
  taskId: string,
  status: string,
): Promise<EveEvalTurn> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const turn = await session.send(`${verificationMessage} ${taskId}`);
    const peeked = turn.toolCalls.find((call) => call.name === "task_peek");
    if (taskStatus(peeked?.output, taskId) === status) {
      await t.require(
        peeked?.output,
        satisfies(
          (output) => taskStatus(output, taskId) === status,
          `task_peek returns ${status} task ${taskId}`,
        ),
      );
      return turn;
    }
    await t.sleep(100);
  }
  throw new Error(`Task ${taskId} did not reach "${status}" after 20 task_peek attempts.`);
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

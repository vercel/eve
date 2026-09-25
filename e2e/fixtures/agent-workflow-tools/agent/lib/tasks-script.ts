import type { MockModelRequest, MockModelResponse, MockModelToolResult } from "eve/evals";

// Deterministic task flows, one `TASKS-*-START` directive per session. Each
// flow names its calls, so later steps find earlier results by call ID, and
// the evals assert on those IDs. The script waits explicitly with task_wait
// so each wait's outcome is visible. A quick task can settle before the
// model's next step, and its result then arrives in a task.result message
// instead; the flows that start one take it from there rather than wait.

type Response = MockModelResponse | string;

const DIRECTIVE_PATTERN = /TASKS-[A-Z]+-START/u;
const RECEIPT_PATTERN = /^(?:Started|Sent to) task ([\w-]+)[.,]/u;

function text(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? null);
}

/** The task ID a start or send receipt names. */
function receiptTaskId(result: MockModelToolResult | undefined): string {
  const taskId = RECEIPT_PATTERN.exec(text(result?.output))?.[1];
  if (taskId === undefined) {
    throw new Error(`Expected a task receipt, got ${text(result?.output)}.`);
  }
  return taskId;
}

export function respondTasks(request: MockModelRequest): Response | undefined {
  const directive = request.userMessages
    .map((message) => DIRECTIVE_PATTERN.exec(message)?.[0])
    .find((match) => match !== undefined);
  if (directive === undefined) return undefined;
  // Compaction summarizes without tools.
  if (request.tools.length === 0) return "TASKS-SUMMARY";
  const last = request.lastUserMessage ?? "";
  // A later user message moves a flow to its next phase; a result message never does.
  const said = (marker: string) => request.userMessages.some((message) => message.includes(marker));
  const result = (id: string) => request.toolResults.find((entry) => entry.id === id);
  // The task.result message that delivered a result containing `marker`, if one did.
  const delivered = (marker: string) =>
    request.userMessages.find(
      (message) => message.startsWith("<task_result") && message.includes(marker),
    );
  const call = (id: string, name: string, input: unknown) => ({ id, input, name });

  switch (directive) {
    // A zero timeout returns at once, an untimed wait returns the result,
    // and a second wait on the task in the same step is refused.
    case "TASKS-WAIT-START": {
      const remind = result("remind");
      if (remind === undefined) {
        return {
          toolCalls: [call("remind", "remind_later", { note: "stretch", seconds: 10 })],
        };
      }
      const taskId = receiptTaskId(remind);
      if (result("peek") === undefined) {
        return { toolCalls: [call("peek", "task_wait", { taskId, timeout: 0 })] };
      }
      if (result("wait-1") === undefined) {
        return {
          toolCalls: [
            call("wait-1", "task_wait", { taskId }),
            call("wait-2", "task_wait", { taskId }),
          ],
        };
      }
      return `TASKS-WAITED ${text(result("wait-1")?.output)}`;
    }

    // A timed wait ends first; the model then ends its turn without the
    // result, the turn holds, and the result arrives in the same turn.
    case "TASKS-TIMEOUT-START": {
      if (last.startsWith("<task_result")) return `TASKS-RESULT ${last}`;
      const remind = result("remind");
      if (remind === undefined) {
        return {
          toolCalls: [call("remind", "remind_later", { note: "water the plants", seconds: 20 })],
        };
      }
      if (result("wait") === undefined) {
        return {
          toolCalls: [call("wait", "task_wait", { taskId: receiptTaskId(remind), timeout: 1_000 })],
        };
      }
      return "TASKS-STILL-WORKING";
    }

    // A steering message ends the wait, not the task; the model then stops
    // the task itself.
    case "TASKS-INTERRUPT-START": {
      const remind = result("remind");
      if (remind === undefined) {
        return {
          toolCalls: [call("remind", "remind_later", { note: "call Bob", seconds: 120 })],
        };
      }
      const taskId = receiptTaskId(remind);
      if (result("wait") === undefined) {
        return { toolCalls: [call("wait", "task_wait", { taskId })] };
      }
      if (!said("TASKS-PING")) {
        return `TASKS-UNEXPECTED ${text(result("wait")?.output)}`;
      }
      if (result("stop") === undefined) {
        return { toolCalls: [call("stop", "task_cancel", { taskId })] };
      }
      return `TASKS-INTERRUPTED ${text(result("stop")?.output)}`;
    }

    // Two tasks start in one step, and one task_wait each in the next.
    case "TASKS-FANIN-START": {
      const first = result("remind-a");
      const second = result("remind-b");
      if (first === undefined || second === undefined) {
        return {
          toolCalls: [
            call("remind-a", "remind_later", { note: "stand-up", seconds: 8 }),
            call("remind-b", "remind_later", { note: "lunch", seconds: 12 }),
          ],
        };
      }
      if (result("wait-a") === undefined) {
        return {
          toolCalls: [
            call("wait-a", "task_wait", { taskId: receiptTaskId(first) }),
            call("wait-b", "task_wait", { taskId: receiptTaskId(second) }),
          ],
        };
      }
      return `TASKS-FANIN ${text(result("wait-a")?.output)} ${text(result("wait-b")?.output)}`;
    }

    // Alice waits on her reminder. Bob's message must not reach her turn.
    case "TASKS-PRINCIPAL-START": {
      if (last.includes("TASKS-BOB")) {
        const wait = text(result("wait")?.output);
        return wait.includes("<task_result") ? "TASKS-BOB-REPLY" : "TASKS-BOB-STEERED";
      }
      const remind = result("remind");
      if (remind === undefined) {
        return {
          toolCalls: [call("remind", "remind_later", { note: "review the report", seconds: 15 })],
        };
      }
      if (result("wait") === undefined) {
        return { toolCalls: [call("wait", "task_wait", { taskId: receiptTaskId(remind) })] };
      }
      return `TASKS-ALICE ${text(result("wait")?.output)}`;
    }

    // A resumable workflow tool: start, revise while idle, wait on it idle,
    // end it, and send to it once it ended.
    case "TASKS-RESUME-START": {
      const start = result("notes-1");
      if (start === undefined) {
        return { toolCalls: [call("notes-1", "draft_notes", { request: "the launch plan" })] };
      }
      const taskId = receiptTaskId(start);
      const draft = delivered("Draft 1:");
      if (draft === undefined && result("notes-wait-1") === undefined) {
        return { toolCalls: [call("notes-wait-1", "task_wait", { taskId })] };
      }
      if (!said("TASKS-REVISE")) {
        return `TASKS-NOTES ${draft ?? text(result("notes-wait-1")?.output)}`;
      }
      if (result("notes-2") === undefined) {
        return {
          toolCalls: [call("notes-2", "draft_notes", { request: "a shorter plan", taskId })],
        };
      }
      const revision = delivered("Draft 2:");
      if (revision === undefined && result("notes-wait-2") === undefined) {
        return { toolCalls: [call("notes-wait-2", "task_wait", { taskId })] };
      }
      if (result("notes-idle") === undefined) {
        return { toolCalls: [call("notes-idle", "task_wait", { taskId })] };
      }
      if (!said("TASKS-CLOSE")) {
        return `TASKS-REVISED ${revision ?? text(result("notes-wait-2")?.output)}`;
      }
      if (result("notes-3") === undefined) {
        return { toolCalls: [call("notes-3", "draft_notes", { request: "done", taskId })] };
      }
      const closed = delivered("Closed the notes.");
      if (closed === undefined && result("notes-wait-3") === undefined) {
        return { toolCalls: [call("notes-wait-3", "task_wait", { taskId })] };
      }
      if (result("notes-4") === undefined) {
        return { toolCalls: [call("notes-4", "draft_notes", { request: "one more", taskId })] };
      }
      return `TASKS-CLOSED ${closed ?? text(result("notes-wait-3")?.output)}`;
    }

    // An agent task: start it, then send it a follow-up by taskId. A send
    // through another tool is refused. The mock child answers at once, so its
    // result reaches the model through task_wait or, when it settles before
    // the next model call, in a task.result message.
    case "TASKS-AGENT-START": {
      const start = result("agent-1");
      if (start === undefined) {
        return {
          toolCalls: [call("agent-1", "workflow-marker", { message: "Alice's first question" })],
        };
      }
      const taskId = receiptTaskId(start);
      if (!said("TASKS-FOLLOW-UP")) {
        if (last.startsWith("<task_result")) return `TASKS-AGENT ${last}`;
        const wait = result("agent-wait-1");
        if (wait === undefined) {
          return { toolCalls: [call("agent-wait-1", "task_wait", { taskId })] };
        }
        return `TASKS-AGENT ${text(wait.output)}`;
      }
      if (result("agent-2") === undefined) {
        return {
          toolCalls: [
            call("mismatch", "draft_notes", { request: "Alice's follow-up", taskId }),
            call("agent-2", "workflow-marker", { message: "Alice's follow-up", taskId }),
          ],
        };
      }
      if (last.startsWith("<task_result")) return `TASKS-AGENT-FOLLOWED-UP ${last}`;
      const wait = result("agent-wait-2");
      if (wait === undefined) {
        return { toolCalls: [call("agent-wait-2", "task_wait", { taskId })] };
      }
      return `TASKS-AGENT-FOLLOWED-UP ${text(wait.output)}`;
    }

    // session.cancel() stops working tasks and leaves an idle one available.
    case "TASKS-CANCEL-START": {
      const draft = result("draft-1");
      if (draft === undefined) {
        return { toolCalls: [call("draft-1", "draft_notes", { request: "the agenda" })] };
      }
      const taskId = receiptTaskId(draft);
      const agenda = delivered("Draft 1:");
      if (agenda === undefined && result("draft-wait-1") === undefined) {
        return { toolCalls: [call("draft-wait-1", "task_wait", { taskId })] };
      }
      if (said("TASKS-AGENDA")) {
        if (result("draft-2") === undefined) {
          return {
            toolCalls: [call("draft-2", "draft_notes", { request: "a shorter agenda", taskId })],
          };
        }
        const revision = delivered("Draft 2:");
        if (revision === undefined && result("draft-wait-2") === undefined) {
          return { toolCalls: [call("draft-wait-2", "task_wait", { taskId })] };
        }
        return `TASKS-AGENDA-REVISED ${revision ?? text(result("draft-wait-2")?.output)}`;
      }
      if (said("TASKS-REMIND")) {
        if (result("cancel-a") !== undefined) return "TASKS-REMINDING";
        return {
          toolCalls: [
            call("cancel-a", "remind_later", { note: "book the room", seconds: 120 }),
            call("cancel-b", "remind_later", { note: "send the invite", seconds: 120 }),
          ],
        };
      }
      return `TASKS-DRAFTED ${agenda ?? text(result("draft-wait-1")?.output)}`;
    }

    default:
      return "TASKS-IDLE";
  }
}

import { defineEval, type EveEvalLiveTurn, type EveEvalSession, type EveEvalTurn } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { reportingControl, type PendingInstruction } from "../agent/lib/reporting-model.js";

const TASK_COUNT = 3;
const MIN_BACKGROUND_TASKS = 2;
const RESULTS = [/\boranges\b/iu, /\bpears\b/iu, /\bapples\b/iu];
const COMPLETION = /Background task (task_[a-z0-9]+) \([^)]+\) is completed\./giu;
const QUESTION =
  "Alice is packing seven boxes with eight jars in each. How many jars is that? Reply with just the number.";

function reportingEval(pendingInstruction?: PendingInstruction) {
  return defineEval({
    description:
      pendingInstruction === undefined
        ? "A stock eve agent acknowledges accepted background work, keeps partial wakes silent, and reports all results after settlement."
        : `After an intermediate task wake, the parent answers a user before settlement, then reports all results (pending instruction ${pendingInstruction}).`,
    tags: pendingInstruction === undefined ? ["real-model"] : ["real-model", "pending-response"],
    metadata: { pendingInstruction: pendingInstruction ?? "stock" },
    async test(t) {
      const control = pendingInstruction === undefined ? "" : reportingControl(pendingInstruction);
      const started =
        await t.send(`${control}Please find the inventory item at each of our three sample warehouses using the built-in agent tool. Start all three lookups in the background without waiting for their results. Delegate the lookups instead of calling probe yourself.

1. "Call probe with check=first and report its result value."
2. "Call probe with check=second and report its result value."
3. "Call probe with check=third and report its result value."`);

      started.expectOk();
      started.calledSubagent("agent", { count: TASK_COUNT }).soft().label("no repeated delegation");
      await t.require(
        started,
        satisfies(
          (turn: EveEvalTurn) => hasPostReceiptAcknowledgement(turn),
          "an acknowledgement follows all background task receipts",
        ),
      );
      await t.require(
        started.message,
        satisfies(
          (message: unknown) =>
            typeof message === "string" &&
            message.trim().length > 0 &&
            RESULTS.every((result) => !result.test(message)),
          "the initiating turn acknowledges work without claiming results",
        ),
      );
      const taskIds = backgroundTaskIds(started);
      await t.require(
        taskIds,
        satisfies(
          (ids: readonly string[]) => ids.length >= MIN_BACKGROUND_TASKS,
          "multiple independent background tasks exercise partial wakes",
        ),
      );

      let session: EveEvalSession | typeof t = t;
      const observed = new Set<string>();
      let finalReport: string | undefined;
      let compactionAttempted = false;
      let question: EveEvalTurn | undefined;
      let questionSent = false;
      let nextTurn: EveEvalLiveTurn | undefined;
      const childSessionIds = new Set<string>();
      collectChildSessions(started, childSessionIds);
      for (
        let attempt = 0;
        attempt < 8 && (observed.size < taskIds.length || (questionSent && question === undefined));
        attempt += 1
      ) {
        const live: EveEvalLiveTurn =
          nextTurn ??
          t.target.watchTurn(started.sessionId, {
            startIndex: requireStreamIndex(session),
          });
        nextTurn = undefined;
        const turn = await live.result();
        collectChildSessions(turn, childSessionIds);
        const completed = completedTaskIds(turn).filter((taskId) => taskIds.includes(taskId));
        for (const taskId of completed) observed.add(taskId);
        t.log(
          `wake ${String(attempt + 1)}: completed=${String(observed.size)}/${String(taskIds.length)} message=${JSON.stringify(turn.message)}`,
        );
        turn.expectOk();

        const receivedQuestion = turn.events.some(
          (event) =>
            event.type === "message.received" && messageText(event.data.message).includes(QUESTION),
        );
        if (receivedQuestion) {
          question = turn;
          question.messageIncludes(/\b56\b/u);
          question.usedNoTools();
          t.log(
            `pending instruction ${pendingInstruction}: user reply=${JSON.stringify(question.message)}`,
          );
        } else if (completed.length > 0 && observed.size < taskIds.length) {
          const silence = t.check(
            turn.message,
            satisfies((message) => message === undefined, "intermediate task wake is silent"),
          );
          // The control may report partial results. Record that behavior without
          // stopping before the user question or failing the control on purpose.
          if (pendingInstruction === "off") silence.soft(0);
        } else if (completed.length > 0) {
          finalReport = turn.message;
        }
        turn.noFailedActions();
        session = live.session;

        if (
          pendingInstruction !== undefined &&
          !questionSent &&
          observed.size > 0 &&
          observed.size < taskIds.length
        ) {
          nextTurn = await live.session.start(QUESTION);
          questionSent = true;
        }

        if (
          pendingInstruction === undefined &&
          !compactionAttempted &&
          observed.size > 0 &&
          observed.size < taskIds.length
        ) {
          const compaction = t.target.watchTurn(started.sessionId, {
            startIndex: requireStreamIndex(session),
          });
          const response = await t.target.fetch(
            `/eve/v1/session/${encodeURIComponent(started.sessionId)}/compact`,
            {
              body: "{}",
              headers: { "content-type": "application/json" },
              method: "POST",
            },
          );
          await t.require(
            response.status,
            satisfies((status: number) => status === 202, "parent session accepts compaction"),
          );
          const compactedTurn = await compaction.result();
          compactedTurn.event("compaction.requested", { count: 1 });
          // A declined summary preserves history; the caller still needs the complete report.
          compactedTurn
            .event("compaction.completed", { count: 1 })
            .soft()
            .label("successful checkpoint");
          compactedTurn.noFailedActions();
          session = compaction.session;
          compactionAttempted = true;
        }
      }

      await t.require(
        [...observed],
        satisfies(
          (ids: readonly string[]) => ids.length === taskIds.length,
          "all task wakes observed",
        ),
      );
      t.check(
        finalReport,
        satisfies(
          (message: unknown) =>
            typeof message === "string" && RESULTS.every((result) => result.test(message)),
          "settled tasks produce a complete user-facing report",
        ),
      );
      if (pendingInstruction === undefined) {
        await t.require(
          compactionAttempted,
          satisfies((value: boolean) => value, "parent session handled compaction between wakes"),
        );
      } else {
        if (question === undefined) throw new Error("No user turn followed the intermediate wake.");
        t.notEvent("compaction.requested");
        await t.require(
          childSessionIds.size,
          satisfies(
            (count) => count === TASK_COUNT,
            "all child sessions are available for timing checks",
          ),
        );
        const children = await Promise.all(
          [...childSessionIds].map((sessionId) => t.target.watchTurn(sessionId).result()),
        );
        const settledAt = Math.max(...children.map(completedAt));
        const received = question.events.find(
          (event) =>
            event.type === "message.received" && messageText(event.data.message).includes(QUESTION),
        );
        const answered = question.events.find(
          (event) =>
            event.type === "message.completed" &&
            event.data.finishReason !== "tool-calls" &&
            /\b56\b/u.test(event.data.message ?? ""),
        );
        const askedAt = received === undefined ? Infinity : Date.parse(received.meta.at);
        const answeredAt = answered === undefined ? Infinity : Date.parse(answered.meta.at);
        t.check(
          askedAt < settledAt,
          satisfies(Boolean, "the user question reached the parent before cohort settlement"),
        );
        t.check(
          answeredAt < settledAt,
          satisfies(Boolean, "the user received an answer before cohort settlement"),
        );
        t.log(
          `pending instruction ${pendingInstruction}: asked=${askedAt} answered=${answeredAt} settled=${settledAt}`,
        );
      }
      t.noFailedActions();
    },
  });
}

export default [
  ...Array.from({ length: 8 }, () => reportingEval()),
  ...Array.from({ length: 20 }, () => [reportingEval("on"), reportingEval("off")]).flat(),
];

function collectChildSessions(turn: EveEvalTurn, sessions: Set<string>): void {
  for (const event of turn.events) {
    if (event.type === "subagent.called") sessions.add(event.data.childSessionId);
  }
}

function completedAt(turn: EveEvalTurn): number {
  const event = turn.events.find((entry) => entry.type === "turn.completed");
  if (event === undefined) throw new Error("Missing child completion event for timing check.");
  return Date.parse(event.meta.at);
}

function backgroundTaskIds(turn: EveEvalTurn): readonly string[] {
  return [
    ...new Set(
      turn.events.flatMap((event) =>
        event.type === "subagent.completed" &&
        event.data.subagentName === "agent" &&
        event.data.backgroundTask !== undefined
          ? [event.data.backgroundTask.taskId]
          : [],
      ),
    ),
  ];
}

function hasPostReceiptAcknowledgement(turn: EveEvalTurn): boolean {
  const receiptIndexes = turn.events.flatMap((event, index) =>
    event.type === "subagent.completed" &&
    event.data.subagentName === "agent" &&
    event.data.backgroundTask !== undefined
      ? [index]
      : [],
  );
  if (receiptIndexes.length < MIN_BACKGROUND_TASKS) return false;
  const lastReceiptIndex = Math.max(...receiptIndexes);
  return turn.events.some(
    (event, index) =>
      index > lastReceiptIndex &&
      event.type === "message.completed" &&
      event.data.finishReason !== "tool-calls" &&
      event.data.message !== null &&
      event.data.message.trim().length > 0,
  );
}

function completedTaskIds(turn: EveEvalTurn): readonly string[] {
  return turn.events.flatMap((event) => {
    if (event.type !== "message.received") return [];
    return [...messageText(event.data.message).matchAll(COMPLETION)].map(
      (match) => match[1] as string,
    );
  });
}

function requireStreamIndex(
  session: EveEvalSession | { readonly state?: { streamIndex: number } },
) {
  if (session.state === undefined) throw new Error("Task reporting session has no stream index.");
  return session.state.streamIndex;
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

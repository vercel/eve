import { defineEval, type EveEvalSession, type EveEvalTurn } from "eve/evals";
import { satisfies } from "eve/evals/expect";

const TASK_COUNT = 3;
const RESULTS = ["WAKE-MECHANISM", "CHANNEL-DELIVERY", "REPORTING-POLICY"] as const;
const COMPLETION = /Background task (task_[a-z0-9]+) \([^)]+\) is completed\./giu;

function reportingEval() {
  return defineEval({
    description:
      "A stock eve agent acknowledges accepted background work, keeps partial wakes silent, and reports once after settlement.",
    tags: ["real-model"],
    async test(t) {
      const started =
        await t.send(`Please investigate these three independent checks using the built-in agent tool. Start them sequentially within this same turn: issue at most one agent call per model step, then use the next model step after its working receipt to issue the next call. Do not wait for a completed result before starting the next agent, and do not call other tools yourself.

1. "Call probe exactly once with check=first. After it returns, reply with exactly the result value from the tool."
2. "Call probe exactly once with check=second. After it returns, reply with exactly the result value from the tool."
3. "Call probe exactly once with check=third. After it returns, reply with exactly the result value from the tool."`);

      started.expectOk();
      started.calledSubagent("agent", { count: TASK_COUNT });
      await t.require(
        started,
        satisfies(
          (turn: EveEvalTurn) => hasPostReceiptAcknowledgement(turn),
          "one non-empty acknowledgement follows all background task receipts",
        ),
      );
      await t.require(
        started.message,
        satisfies(
          (message: unknown) =>
            typeof message === "string" &&
            message.trim().length > 0 &&
            RESULTS.every((result) => !message.includes(result)),
          "the initiating turn acknowledges work without claiming results",
        ),
      );
      const taskIds = backgroundTaskIds(started);
      await t.require(
        taskIds,
        satisfies(
          (ids: readonly string[]) => ids.length === TASK_COUNT && new Set(ids).size === TASK_COUNT,
          "three distinct background task receipts",
        ),
      );

      let session: EveEvalSession | typeof t = t;
      const observed = new Set<string>();
      let finalReports = 0;
      let compacted = false;
      for (let attempt = 0; attempt < 8 && observed.size < TASK_COUNT; attempt += 1) {
        const live = t.target.watchTurn(started.sessionId, {
          startIndex: requireStreamIndex(session),
        });
        const turn = await live.result();
        const completed = completedTaskIds(turn).filter((taskId) => taskIds.includes(taskId));
        for (const taskId of completed) observed.add(taskId);
        t.log(
          `wake ${String(attempt + 1)}: completed=${String(observed.size)}/${String(TASK_COUNT)} message=${JSON.stringify(turn.message)}`,
        );

        if (observed.size < TASK_COUNT) {
          await t.require(
            turn.message,
            satisfies((message) => message === undefined, "intermediate task wake is silent"),
          );
        } else if (turn.message !== undefined) {
          finalReports += 1;
          await t.require(
            turn.message,
            satisfies(
              (message: string) => RESULTS.every((result) => message.includes(result)),
              "final report consolidates every task result",
            ),
          );
        }
        turn.noFailedActions();
        session = live.session;

        if (!compacted && observed.size > 0 && observed.size < TASK_COUNT) {
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
          compactedTurn.event("compaction.completed", { count: 1 });
          compactedTurn.noFailedActions();
          session = compaction.session;
          compacted = true;
        }
      }

      await t.require(
        [...observed],
        satisfies((ids: readonly string[]) => ids.length === TASK_COUNT, "all task wakes observed"),
      );
      await t.require(
        finalReports,
        satisfies((count: number) => count === 1, "exactly one final user-facing report"),
      );
      await t.require(
        compacted,
        satisfies((value: boolean) => value, "parent session was compacted between wakes"),
      );
      t.noFailedActions();
    },
  });
}

export default Array.from({ length: 8 }, reportingEval);

function backgroundTaskIds(turn: EveEvalTurn): readonly string[] {
  return turn.events.flatMap((event) =>
    event.type === "subagent.completed" &&
    event.data.subagentName === "agent" &&
    event.data.backgroundTask !== undefined
      ? [event.data.backgroundTask.taskId]
      : [],
  );
}

function hasPostReceiptAcknowledgement(turn: EveEvalTurn): boolean {
  const receiptIndexes = turn.events.flatMap((event, index) =>
    event.type === "subagent.completed" &&
    event.data.subagentName === "agent" &&
    event.data.backgroundTask !== undefined
      ? [index]
      : [],
  );
  if (receiptIndexes.length !== TASK_COUNT) return false;
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

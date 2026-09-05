import { defineEval, type EveEvalSession, type EveEvalTurn } from "eve/evals";
import { satisfies } from "eve/evals/expect";

const TASK_COUNT = 3;
const MIN_BACKGROUND_TASKS = 2;
const RESULTS = ["WAKE-MECHANISM", "CHANNEL-DELIVERY", "REPORTING-POLICY"] as const;
const COMPLETION = /Background task (task_[a-z0-9]+) \([^)]+\) is completed\./giu;

function reportingEval() {
  return defineEval({
    description:
      "A stock eve agent acknowledges accepted background work, keeps partial wakes silent, and reports all results after settlement.",
    tags: ["real-model"],
    async test(t) {
      const started =
        await t.send(`Please investigate these three independent checks using the built-in agent tool. Start all three in the background without waiting for their results. Delegate the checks instead of calling probe yourself.

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
            RESULTS.every((result) => !message.includes(result)),
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
      let compacted = false;
      for (let attempt = 0; attempt < 8 && observed.size < taskIds.length; attempt += 1) {
        const live = t.target.watchTurn(started.sessionId, {
          startIndex: requireStreamIndex(session),
        });
        const turn = await live.result();
        const completed = completedTaskIds(turn).filter((taskId) => taskIds.includes(taskId));
        for (const taskId of completed) observed.add(taskId);
        t.log(
          `wake ${String(attempt + 1)}: completed=${String(observed.size)}/${String(taskIds.length)} message=${JSON.stringify(turn.message)}`,
        );
        turn.expectOk();

        if (observed.size < taskIds.length) {
          await t.require(
            turn.message,
            satisfies((message) => message === undefined, "intermediate task wake is silent"),
          );
        } else {
          finalReport = turn.message;
        }
        turn.noFailedActions();
        session = live.session;

        if (!compacted && observed.size > 0 && observed.size < taskIds.length) {
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
        satisfies(
          (ids: readonly string[]) => ids.length === taskIds.length,
          "all task wakes observed",
        ),
      );
      await t.require(
        finalReport,
        satisfies(
          (message: unknown) =>
            typeof message === "string" && RESULTS.every((result) => message.includes(result)),
          "settled tasks produce a complete user-facing report",
        ),
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

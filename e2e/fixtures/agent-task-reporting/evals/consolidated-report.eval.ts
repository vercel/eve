import { defineEval, type EveEvalSession, type EveEvalTurn } from "eve/evals";
import { satisfies } from "eve/evals/expect";

const TASK_COUNT = 3;
const RESULTS = ["WAKE-MECHANISM", "CHANNEL-DELIVERY", "REPORTING-POLICY"] as const;
const COMPLETION = /Background task (task_[a-z0-9]+) \([^)]+\) is completed\./giu;

function reportingEval() {
  return defineEval({
    description:
      "Related background results produce no intermediate delivery and one consolidated final report.",
    async test(t) {
      if (new URL(t.target.url).hostname.endsWith(".vercel.app")) {
        t.skip("The in-process timer executor is not restart-safe on a serverless deployment.");
      }

      const started = await t.send(`TASK-REPORTING-PROBE

Call report_probe exactly three times in one response and call no other tool:

1. delayMs=10000, result=WAKE-MECHANISM
2. delayMs=40000, result=CHANNEL-DELIVERY
3. delayMs=70000, result=REPORTING-POLICY

After the three task receipts, reply only with "investigation started". Then handle the background results normally.`);

      started.expectOk();
      started.calledTool("report_probe", { count: TASK_COUNT });
      started.messageIncludes("investigation started");
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
  return turn.events.flatMap((event) => {
    if (
      event.type !== "action.result" ||
      event.data.result.kind !== "tool-result" ||
      event.data.result.toolName !== "report_probe"
    ) {
      return [];
    }
    const output = event.data.result.output;
    if (output === null || typeof output !== "object") return [];
    const taskId = Reflect.get(output, "taskId");
    return typeof taskId === "string" ? [taskId] : [];
  });
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

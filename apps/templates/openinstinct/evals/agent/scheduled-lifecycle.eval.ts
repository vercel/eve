import { defineEval, type EveEvalTurn } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";
import { sendMessageOutputSchema } from "@shared/chat/message-delivery";
import { agentEvalTags } from "@evals/agent/shared";
import { accessScopeForUser } from "@shared/identity/access-scope";

function nextLine(events: EveEvalTurn["events"], fallback = 0) {
  const last = events.at(-1);
  return last ? last.meta.position.line + 1 : fallback;
}

const cases = [
  {
    expectedDelivery: "$95",
    result: "The monitored price dropped from $120 to $95.",
  },
  {
    expectedDelivery: null,
    result: "The monitored price is still $95. Nothing changed.",
  },
] as const;

export default defineEval({
  description: "Delivers useful scheduled results and suppresses noise",
  tags: [...agentEvalTags, "schedules", "lifecycle", "notification"],
  timeoutMs: 180_000,
  async test(t) {
    const initial = await t.send(
      "I only want price-monitor updates when the price changes. Reply with exactly 'Schedule lifecycle harness ready.'"
    );
    initial.expectOk();
    initial.succeeded();
    // Stream reads resume by line, not by event count.
    let mainLine = nextLine(initial.events);
    const { createScheduledAgentJob, listScheduledAgentJobs } =
      await import("@db/services/scheduled-agent-jobs");
    const scope = accessScopeForUser("better-auth:browser-benchmark");
    const conversation = {
      conversationChannel: "eve" as const,
      conversationId: initial.sessionId,
    };

    const runCase = async (testCase: (typeof cases)[number]) => {
      const dueAt = new Date(Date.now() - 1_000);
      const job = await createScheduledAgentJob(
        scope,
        {
          ...conversation,
          missedRunPolicy: "run_latest",
          prompt: `Return exactly this text as your concise final handoff without calling tools: ${testCase.result}`,
          timing: { at: dueAt.toISOString(), kind: "once" },
        },
        new Date(dueAt.getTime() - 1_000)
      );

      const dispatch = await t.target.dispatchSchedule("dynamic");
      const sessionIds = await t.require(
        dispatch.sessionIds,
        satisfies<readonly string[]>(
          (ids) => ids.length === 1,
          "one due scheduled worker session was dispatched"
        )
      );
      const workerSessionId = sessionIds[0];
      if (!workerSessionId) {
        throw new Error("Schedule dispatch did not return a worker session.");
      }

      const worker = await t.target.attach(workerSessionId).nextTurn();
      worker.succeeded();
      worker.outputEquals(testCase.result);

      const stored = (await listScheduledAgentJobs(scope, conversation)).find(
        (candidate) => candidate.id === job.id
      );
      const runId = await t.require(
        stored?.latestRun?.id,
        satisfies<string | undefined>(
          (value) => value !== undefined,
          "the scheduled worker persisted a run"
        )
      );
      if (!runId) throw new Error("The scheduled run was not persisted.");

      const reportResponse = await t.target.fetch(
        "/internal/scheduled-run/report",
        {
          body: JSON.stringify({ runId }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }
      );
      await t.require(reportResponse.status, equals(202));

      const report = await t.target
        .attach(initial.sessionId, { startIndex: mainLine })
        .nextTurn();
      report.succeeded();
      if (testCase.expectedDelivery === null) {
        report.notCalledTool("send_message");
      } else {
        report.calledTool("send_message", {
          input: (input) => {
            const parsed = sendMessageOutputSchema.safeParse(input);
            return (
              parsed.success &&
              parsed.data.kind === "message" &&
              parsed.data.text?.includes(testCase.expectedDelivery) === true
            );
          },
          status: "completed",
          count: 1,
        });
      }
      report.notCalledTool("run_browser");
      mainLine = nextLine(report.events, mainLine);
    };

    await runCase(cases[0]);
    await runCase(cases[1]);
  },
});

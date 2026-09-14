import { defineEval } from "eve/evals";

const STAGES = ["ticket-triage", "ticket-review", "ticket-reproducer"] as const;
const STAGE_NAMES = new Set<string>(STAGES);

function isSoftwareFactoryProgram(input: unknown): boolean {
  if (typeof input !== "object" || input === null) return false;
  const js = (input as { js?: unknown }).js;
  if (typeof js !== "string") return false;

  const stageOffsets = STAGES.map((stage) => js.indexOf(stage));
  return (
    /Array\.from\s*\(\s*\{\s*length\s*:\s*200\s*\}/u.test(js) &&
    stageOffsets.every((offset) => offset >= 0) &&
    stageOffsets[0]! < stageOffsets[1]! &&
    stageOffsets[1]! < stageOffsets[2]! &&
    /stage\s*:\s*["']triage["']/u.test(js) &&
    /stage\s*:\s*["']review["']/u.test(js) &&
    /stage\s*:\s*["']reproduce["']/u.test(js) &&
    /\{\s*stage\s*:\s*["']review["']\s*,\s*triage\s*\}/u.test(js) &&
    /\{\s*stage\s*:\s*["']reproduce["']\s*,\s*triage\s*,\s*review\s*\}/u.test(js) &&
    /return\s*\{\s*triage\s*,\s*review\s*,\s*reproduction\s*\}/u.test(js)
  );
}

/** A model-authored workflow carries a software-factory batch through three dependent stages. */
export default defineEval({
  tags: ["real-model"],
  description:
    "The root agent composes triage, review, and reproduction as separate sequential workflow stages over 200 synthetic tickets.",
  async test(t) {
    const turn = await t.send(
      [
        "Alice is processing a manufactured software-factory backlog. Use the workflow tool exactly once to build the complete pipeline as JavaScript, and do not call any of its subagents outside workflow.",
        "Create `tickets` with `Array.from({ length: 200 }, ...)`. Give every ticket a zero-padded `T-` id, an area selected from api, cli, runtime, and docs, a severity, and a synthetic regression title.",
        'First await ticket-triage with `JSON.stringify({ stage: "triage", tickets })`. Request an object with integer `ticketCount`, string-array `priorityTickets`, and string-array `themes`.',
        'Next await ticket-review with `JSON.stringify({ stage: "review", triage })`. Request an object with boolean `accepted`, string `summary`, and string-array `risks`.',
        'Finally await ticket-reproducer with `JSON.stringify({ stage: "reproduce", triage, review })`. Request an object with string `sampleTicket`, string-array `files`, string `command`, and string `testCase`.',
        "Return `{ triage, review, reproduction }` from the workflow and reply with that returned object verbatim as JSON.",
      ].join(" "),
    );

    turn.expectOk();
    t.succeeded();
    t.calledTool("workflow", { input: isSoftwareFactoryProgram, count: 1 });
    for (const stage of STAGES) t.calledSubagent(stage, { count: 1 });
    turn.eventsSatisfy("each pipeline stage completes before the next starts", (events) => {
      const called = new Map<string, number>();
      const completed = new Map<string, number>();
      for (const [index, event] of events.entries()) {
        if (event.type === "subagent.called" && STAGE_NAMES.has(event.data.name)) {
          if (!called.has(event.data.name)) called.set(event.data.name, index);
        }
        if (event.type === "subagent.completed" && STAGE_NAMES.has(event.data.subagentName)) {
          if (!completed.has(event.data.subagentName)) {
            completed.set(event.data.subagentName, index);
          }
        }
      }
      const triageCompleted = completed.get("ticket-triage");
      const reviewCalled = called.get("ticket-review");
      const reviewCompleted = completed.get("ticket-review");
      const reproduceCalled = called.get("ticket-reproducer");
      return (
        called.size === 3 &&
        completed.size === 3 &&
        triageCompleted !== undefined &&
        reviewCalled !== undefined &&
        reviewCompleted !== undefined &&
        reproduceCalled !== undefined &&
        triageCompleted < reviewCalled &&
        reviewCompleted < reproduceCalled
      );
    });
    t.messageIncludes("TRIAGE_STAGE_COMPLETE");
    t.messageIncludes("REVIEW_STAGE_COMPLETE");
    t.messageIncludes("reproductions/T-000.test.ts");
    t.messageIncludes("T-000 reproduction");
    t.noFailedActions();
  },
});

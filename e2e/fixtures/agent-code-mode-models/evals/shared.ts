import { e2eModel } from "@eve-e2e/config";
import type { EveEvalContext, EveEvalTurn } from "eve/evals";
import type { Call } from "../src/audit";
import { inOneProgram } from "../src/checks";

export async function audit(t: EveEvalContext, turn: EveEvalTurn) {
  turn.expectOk();
  const model = e2eModel();
  if (typeof model !== "string") throw new Error("Planning evals require a real matrix model");
  turn.eventsSatisfy("the configured real model ran the task", (events) => {
    const steps = events.filter((event) => event.type === "step.started");
    return steps.length > 0 && steps.every((event) => event.data.modelId === model);
  });
  const path = `/planning-audit?sessionId=${encodeURIComponent(turn.sessionId)}`;
  const response = await t.target.fetch(path);
  if (!response.ok) throw new Error(`Reading planning audit failed: ${response.status}`);
  const calls = (await response.json()) as Call[];
  const cleanup = await t.target.fetch(path, { method: "DELETE" });
  if (!cleanup.ok) throw new Error(`Clearing planning audit failed: ${cleanup.status}`);
  const programs = turn.events.flatMap((event) =>
    event.type === "action.result" &&
    event.data.status === "completed" &&
    event.data.result.kind === "tool-result" &&
    event.data.result.toolName === "code_mode"
      ? [event.data.result.callId]
      : [],
  );
  const pages = calls.filter((call) => call.tool === "orders");
  const cursors = new Set(
    pages.map((call) => (call.input as { cursor?: string | null }).cursor ?? null),
  );
  t.log(
    JSON.stringify({
      model,
      calls,
      completedPrograms: programs,
      allDataCallsInOneProgram: inOneProgram(calls, programs),
      repeatedPageReads: pages.length - cursors.size,
    }),
  );
  return calls;
}

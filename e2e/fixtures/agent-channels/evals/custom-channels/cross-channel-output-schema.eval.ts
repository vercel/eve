import { defineEval } from "eve/evals";

import { postChannel } from "./shared.js";

/** Structured-output smoke for the cross-channel `args.receive` handoff. */
export default defineEval({
  description: "Custom channel smoke: structured cross-channel receive.",

  async test(t) {
    const payload = await postChannel<{ ok: boolean; sessionId?: string }>(t.target, "/webhook", {
      message:
        'Return exactly one structured result with title "handoff" and count 1. Do not answer in prose.',
      structured: true,
    });
    if (payload.ok !== true || typeof payload.sessionId !== "string") {
      throw new Error(`Unexpected webhook response: ${JSON.stringify(payload)}`);
    }

    const session = await t.target.attachSession(payload.sessionId);
    const results = session.events.filter((event) => event.type === "result.completed");
    if (results.length !== 1) {
      const failures = session.events.filter(
        (event) =>
          event.type === "session.failed" ||
          event.type === "turn.failed" ||
          event.type === "step.failed",
      );
      throw new Error(
        `Expected one result.completed event, received ${results.length}. ` +
          `Observed events: ${session.events.map((event) => event.type).join(", ")}. ` +
          `Failures: ${JSON.stringify(failures)}.`,
      );
    }

    const result = results[0]?.data.result;
    if (
      !isRecord(result) ||
      typeof result.title !== "string" ||
      typeof result.count !== "number" ||
      !Number.isInteger(result.count) ||
      Object.keys(result).some((key) => key !== "count" && key !== "title") ||
      Object.keys(result).length !== 2
    ) {
      throw new Error(`Unexpected structured result: ${JSON.stringify(result)}`);
    }

    t.didNotFail();
    t.completed();
  },
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

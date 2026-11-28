import { appendFileSync } from "node:fs";
import { defineInstrumentation } from "eve/instrumentation";

const o11yPath = process.env.EVE_BENCH_O11Y_PATH;

function write(event: { readonly type: string }): void {
  if (!o11yPath) return;
  try {
    appendFileSync(
      o11yPath,
      `${JSON.stringify({
        wallTime: new Date().toISOString(),
        monotonicNs: process.hrtime.bigint().toString(),
        event: "lifecycle",
        type: event.type,
        data: event,
      })}\n`,
    );
  } catch {
    // Benchmark capture must never affect the agent run.
  }
}

export default defineInstrumentation({
  tracePolicy: () => ({ emit: true, recordInputs: true, recordOutputs: true }),
  events: {
    "session.started": write,
    "session.ended": write,
    "turn.started": write,
    "turn.settled": write,
    "model.started": write,
    "model.settled": write,
    "model.retried": write,
    "model.call.started": write,
    "model.call.settled": write,
    "call.requested": write,
    "call.settled": write,
    "interaction.opened": write,
    "interaction.settled": write,
    "delivery.consumed": write,
    "delivery.settled": write,
  },
});

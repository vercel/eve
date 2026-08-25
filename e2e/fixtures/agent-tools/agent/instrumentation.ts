import { defineInstrumentation } from "eve/instrumentation";

declare global {
  var __eveInstrumentationSnapshot: unknown;
}

export default defineInstrumentation({
  events: {
    "step.started"(input) {
      globalThis.__eveInstrumentationSnapshot = input.channel;
      return undefined;
    },
  },
  recordInputs: true,
});

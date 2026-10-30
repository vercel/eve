import { setImmediate } from "node:timers/promises";

import { defineInstrumentation } from "eve/instrumentation";

import marker from "../../authored-assets/instrumentation.txt?raw";

// Instrumentation and tools are bundled separately, so the test needs process-wide state.
declare global {
  var eveE2eInstrumentationReady: boolean | undefined;
}

const INSTRUMENTATION_MARKER = "authored-instrumentation-asset";

if (marker.trim() !== INSTRUMENTATION_MARKER) {
  throw new Error("Authored instrumentation asset did not preserve its contents.");
}

export default defineInstrumentation({
  async setup() {
    await setImmediate();
    globalThis.eveE2eInstrumentationReady = true;
  },
});

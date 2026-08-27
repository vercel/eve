import { defineInstrumentation } from "eve/instrumentation";

import marker from "../authored-assets/instrumentation.txt?raw";

const INSTRUMENTATION_MARKER = "authored-instrumentation-asset";

if (marker.trim() !== INSTRUMENTATION_MARKER) {
  throw new Error("Authored instrumentation asset did not preserve its contents.");
}

export default defineInstrumentation({
  functionId: INSTRUMENTATION_MARKER,
});

import { defineCatalystEveInstrumentation } from "@inference/tracing/eve";
import { defineInstrumentation } from "eve/instrumentation";

export default defineInstrumentation(
  defineCatalystEveInstrumentation({
    recordInputs: false,
    recordOutputs: false,
  }) as Parameters<typeof defineInstrumentation>[0],
);

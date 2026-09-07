import { telemetryDevInstrumentation } from "@telemetry-dev/eve";
import { defineInstrumentation } from "eve/instrumentation";

export default defineInstrumentation(telemetryDevInstrumentation());

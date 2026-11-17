import type { JsonObject } from "eve/events";
import { otelIntegration } from "eve/instrumentation/otel";

// Tags each model-call span with the request ID that agent/hooks/evlog.ts puts
// on the turn's wide event, so traces and wide events correlate. evlog's own
// evlogRuntimeContext depends on its v26 hook state, which eve 1.0 never fills.
export default otelIntegration({
  runtimeContext({ session, turn }): JsonObject {
    if (!turn) return { "evlog.session_id": session.id };
    return {
      "evlog.request_id": `${session.id}:${turn.id}`,
      "evlog.session_id": session.id,
    };
  },
});

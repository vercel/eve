import { trace } from "@opentelemetry/api";
import { liveOtelBackend } from "#tracing/eve/otel.js";
import { eveOutputMapping } from "#tracing/eve/profile.js";
import { createTransportLifecycle } from "#tracing/eve/transport-lifecycle.js";
import { aiSdkContentSerializer } from "#tracing/eve/serialization.js";
import { createMcpTracing } from "#tracing/eve/mcp.js";

export const eveMcpTracing = () =>
  createMcpTracing(
    createTransportLifecycle(
      liveOtelBackend(trace.getTracer("eve.mcp"), eveOutputMapping()),
      aiSdkContentSerializer,
    ),
  );
export const eveTransportLifecycle = () =>
  createTransportLifecycle(
    liveOtelBackend(trace.getTracer("eve.channel"), eveOutputMapping()),
    aiSdkContentSerializer,
  );

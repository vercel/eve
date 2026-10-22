import { verifyMcpEvent } from "#compiled/@vercel/connect-events/index.js";
import { traceConnectionEventRequest } from "#internal/nitro/routes/channel-request-instrumentation.js";
import {
  connectionEventAttributes,
  connectionEventError,
  connectionEventTraceContext,
} from "#tracing/eve/connection-events.js";
import { createLogger, logError } from "#internal/logging.js";
import type { NitroArtifactsConfig } from "#internal/nitro/routes/runtime-artifacts.js";
import { resolveNitroCompiledArtifactsSource } from "#internal/nitro/routes/runtime-artifacts.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import { connectionEventDestination } from "#runtime/connections/events/path.js";
import { startConnectionEventDelivery } from "#runtime/connections/events/owner.js";
import { isObject } from "#shared/guards.js";

export async function handleConnectionEventRequest(
  input: { artifactsConfig: NitroArtifactsConfig; connectionName?: string },
  request: Request,
): Promise<Response> {
  return traceConnectionEventRequest(request, async (span) => {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const connectionName = input.connectionName ?? new URL(request.url).pathname.split("/").at(-1)!;
    // Extension namespaces also allow uppercase letters and underscores.
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,255}$/.test(connectionName))
      return new Response(null, { status: 404 });
    let stage = "load";
    let identifiers: Record<string, string> = {};
    try {
      const bundle = await getCompiledRuntimeAgentBundle({
        compiledArtifactsSource: resolveNitroCompiledArtifactsSource(input.artifactsConfig),
      });
      const events = bundle.resolvedAgent.connections.find(
        (connection) => connection.connectionName === connectionName,
      )?.experimental_events;
      if (
        events === undefined &&
        (bundle.resolvedAgent.dynamicConnectionResolvers?.length ?? 0) === 0
      )
        return new Response(null, { status: 404 });
      stage = "verify";
      const delivery = await (events?.backend.verify ?? verifyMcpEvent)(request, {
        path: connectionEventDestination(connectionName),
      });
      const origin = delivery.context.eve;
      if (
        !isObject(origin) ||
        origin.version !== 1 ||
        typeof origin.sessionId !== "string" ||
        origin.sessionId.length === 0 ||
        origin.sessionId.length > 256 ||
        origin.sessionId.includes(":") ||
        typeof origin.bindingId !== "string" ||
        !/^[a-f0-9]{64}$/.test(origin.bindingId)
      )
        return new Response(null, { status: 400 });
      identifiers = connectionEventAttributes({
        connectionName: connectionName,
        sessionId: origin.sessionId,
        deliveryId: delivery.deliveryId,
        subscriptionId: delivery.subscriptionId,
      });
      for (const [key, value] of Object.entries(identifiers)) span?.setAttribute(key, value);
      stage = "handler";
      const requestTraceContext = connectionEventTraceContext(span?.spanContext());
      // Context locates the watch. The binding its hook carries authorizes execution.
      const started = await startConnectionEventDelivery(
        {
          kind: "connection-event",
          connectionName: connectionName,
          bindingId: origin.bindingId,
          delivery,
          requestTraceContext,
        },
        bundle,
      );
      // 410 tells Connect the watch has ended, so it stops delivering.
      return new Response(null, { status: started ? 202 : 410 });
    } catch (error) {
      if (isObject(error) && error.code === "invalid_delivery")
        return new Response(null, { status: 401 });
      logError(
        createLogger("connection.events.receiver"),
        "connection event receipt failed",
        connectionEventError(error),
        { ...identifiers, stage },
      );
      return new Response(null, { status: 503, headers: { "Retry-After": "5" } });
    }
  });
}

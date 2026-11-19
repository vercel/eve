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
import { connectionEventDestination } from "#runtime/subscriptions/path.js";
import { installedDurableHost } from "#execution/hosts.js";
import { isObject } from "#shared/guards.js";
import type { JsonValue } from "#shared/json.js";

export async function handleConnectionEventRequest(
  input: { artifactsConfig: NitroArtifactsConfig; connectionName: string },
  request: Request,
): Promise<Response> {
  return traceConnectionEventRequest(request, async (span) => {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    let stage = "load";
    let identifiers: Record<string, string> = {};
    try {
      const bundle = await getCompiledRuntimeAgentBundle({
        compiledArtifactsSource: resolveNitroCompiledArtifactsSource(input.artifactsConfig),
      });
      const events = bundle.resolvedAgent.connections.find(
        (connection) => connection.connectionName === input.connectionName,
      )?.experimental_events;
      if (events === undefined) return new Response(null, { status: 404 });
      stage = "verify";
      const delivery = await events.backend.verify(request, {
        path: connectionEventDestination(input.connectionName),
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
        connectionName: input.connectionName,
        sessionId: origin.sessionId,
        deliveryId: delivery.deliveryId,
        subscriptionId: delivery.subscriptionId,
      });
      for (const [key, value] of Object.entries(identifiers)) span?.setAttribute(key, value);
      stage = "handler";
      const requestTraceContext = connectionEventTraceContext(span?.spanContext());
      const owners = installedDurableHost()?.subscriptions;
      if (owners === undefined) throw new Error("This host keeps no subscriptions.");
      const emitted = await owners.emit(
        { kind: "connection", name: input.connectionName },
        delivery.subscriptionId,
        { id: delivery.deliveryId, data: delivery as unknown as JsonValue, requestTraceContext },
      );
      if (emitted) return new Response(null, { status: 202 });
      // The subscription's owner exists but has not joined its key yet, or is closing: Connect retries.
      if ((await owners.find(origin.bindingId)) !== undefined)
        return new Response(null, { status: 503, headers: { "Retry-After": "5" } });
      return new Response(null, { status: 410 });
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

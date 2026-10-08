import type { NitroArtifactsConfig } from "#internal/nitro/routes/runtime-artifacts.js";
import { resolveNitroCompiledArtifactsSource } from "#internal/nitro/routes/runtime-artifacts.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import { connectionEventDestination } from "#runtime/connections/events/path.js";
import { resumeSessionInbox } from "#execution/session-inbox/resume.js";
import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { isObject } from "#shared/guards.js";

export async function handleConnectionEventRequest(
  input: { artifactsConfig: NitroArtifactsConfig; connectionName: string },
  request: Request,
): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  try {
    const bundle = await getCompiledRuntimeAgentBundle({
      compiledArtifactsSource: resolveNitroCompiledArtifactsSource(input.artifactsConfig),
    });
    const connection = bundle.resolvedAgent.connections.find(
      (connection) => connection.connectionName === input.connectionName,
    );
    const auth = connection?.authorization;
    if (
      connection?.experimental_events === undefined ||
      auth === undefined ||
      typeof auth === "function" ||
      auth.vercelConnect?.experimental_events === undefined
    )
      return new Response(null, { status: 404 });
    const delivery = await auth.vercelConnect.experimental_events.verify(request, {
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
    // Context locates the inbox. The owner authorizes the stored binding after
    // the subscribe step commits, before invoking any authored callback.
    await resumeSessionInbox(
      { sessionId: origin.sessionId },
      {
        kind: "connection-event",
        connectionName: input.connectionName,
        bindingId: origin.bindingId,
        delivery,
      },
    );
    return new Response(null, { status: 202 });
  } catch (error) {
    if (HookNotFoundError.is(error)) return new Response(null, { status: 410 });
    if (isObject(error) && error.code === "invalid_delivery")
      return new Response(null, { status: 401 });
    return new Response(null, { status: 503, headers: { "Retry-After": "5" } });
  }
}

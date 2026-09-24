import { readRemoteAgentStreamHeadersResolver } from "#internal/nitro/routes/channel-route-context.js";
import {
  EVE_SESSION_ID_HEADER,
  EVE_STREAM_CONTROL_VERSION_QUERY,
  EVE_STREAM_FORMAT_HEADER,
  EVE_STREAM_TAIL_INDEX_HEADER,
  EVE_STREAM_VERSION_HEADER,
} from "#protocol/message.js";
import {
  createEveSessionStreamRoutePath,
  createEveSubagentStreamRoutePath,
} from "#protocol/routes.js";
import type { RouteHandlerArgs } from "#public/definitions/channel.js";
import { routeAuth } from "#public/channels/auth.js";
import { parseIncludeTailIndex, parseStartIndex } from "#eve-channel/request.js";
import { findRemoteSubagentBinding, type RemoteSubagentBinding } from "#eve-channel/support.js";
import type { EveChannelInput } from "#eve-channel/types.js";

/**
 * Relays one remote child's stream through its parent session, so a client
 * follows the child without calling the remote deployment or holding its
 * credentials.
 */
export async function handleSubagentStreamRequest(
  input: Pick<EveChannelInput, "auth">,
  req: Request,
  args: RouteHandlerArgs,
): Promise<Response> {
  const authResult = await routeAuth(req, input.auth);
  if (authResult instanceof Response) return authResult;

  const parentSessionId = args.params.parentSessionId;
  const callId = args.params.callId;
  const childSessionId = args.params.childSessionId;
  if (!parentSessionId || !callId || !childSessionId) {
    return Response.json(
      { error: "Missing subagent stream coordinates.", ok: false },
      { status: 400 },
    );
  }

  const startIndex = parseStartIndex(req);
  if (startIndex instanceof Response) return startIndex;
  const includeTailIndex = parseIncludeTailIndex(req);

  const childStreamPath = createEveSubagentStreamRoutePath({
    callId,
    childSessionId,
    parentSessionId,
  });
  let binding: RemoteSubagentBinding;
  try {
    const parent = args.attachSession(parentSessionId);
    const found = await findRemoteSubagentBinding({
      callId,
      childSessionId,
      childStreamPath,
      parent,
    });
    if (found === undefined) {
      throw new Error("Remote subagent binding not found.");
    }
    binding = found;
  } catch {
    return Response.json({ error: "Subagent stream not found.", ok: false }, { status: 404 });
  }

  const resolveHeaders = readRemoteAgentStreamHeadersResolver(args);
  if (resolveHeaders === undefined) {
    return Response.json(
      {
        error: "Subagent stream proxy requires internal channel dispatch context.",
        ok: false,
      },
      { status: 500 },
    );
  }

  let headers: Record<string, string>;
  try {
    headers = await resolveHeaders({
      name: binding.name,
      resolverId: binding.remote.resolverId,
      url: binding.remote.url,
    });
  } catch {
    return Response.json({ error: "Subagent stream not found.", ok: false }, { status: 404 });
  }

  const upstreamUrl = new URL(
    createEveSessionStreamRoutePath(childSessionId).replace(/^\/+/, ""),
    `${binding.remote.url.replace(/\/+$/, "")}/`,
  );
  if (startIndex !== undefined) {
    upstreamUrl.searchParams.set("startIndex", String(startIndex));
  }
  const controlVersion = new URL(req.url).searchParams.get(EVE_STREAM_CONTROL_VERSION_QUERY);
  if (controlVersion !== null) {
    upstreamUrl.searchParams.set(EVE_STREAM_CONTROL_VERSION_QUERY, controlVersion);
  }
  if (includeTailIndex) {
    upstreamUrl.searchParams.set("includeTailIndex", "1");
  }

  const upstream = await fetch(upstreamUrl, {
    cache: "no-store",
    headers,
    redirect: "manual",
    signal: req.signal,
  });
  const responseHeaders = new Headers();
  for (const name of [
    "cache-control",
    "content-type",
    "x-accel-buffering",
    EVE_SESSION_ID_HEADER,
    EVE_STREAM_FORMAT_HEADER,
    EVE_STREAM_TAIL_INDEX_HEADER,
    EVE_STREAM_VERSION_HEADER,
  ]) {
    const value = upstream.headers.get(name);
    if (value !== null) responseHeaders.set(name, value);
  }
  return new Response(upstream.body, {
    headers: responseHeaders,
    status: upstream.status,
    statusText: upstream.statusText,
  });
}

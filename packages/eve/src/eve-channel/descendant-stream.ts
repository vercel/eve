import { internalSession, type Session } from "#channel/session.js";
import type { ChildOpened } from "#protocol/session-events/families/child.js";
import type { StoredLine } from "#protocol/session-events/envelope.js";
import { createEventReader } from "#protocol/session-lines.js";
import {
  createEveDescendantStreamRoutePath,
  createEveSessionStreamRoutePath,
} from "#protocol/routes.js";
import {
  DESCENDANT_MAX_DEPTH,
  EVE_OBSERVATION_KEY_HEADER,
  localObservationKey,
  type DescendantHop,
} from "#protocol/descendant-observation.js";
import { createSessionStreamResponse } from "#eve-channel/request.js";
import { findRemoteAgentBinding, type RemoteAgentBinding } from "#eve-channel/support.js";
import { proxyStreamHeaders } from "#eve-channel/stream-headers.js";

/** Every hop resolves recorded authority on its owning deployment, never an event-supplied URL. */
export async function descendantStreamResponse(input: {
  readonly request: Request;
  readonly root: Session;
  readonly attachSession: (id: string) => Session;
  readonly resolveHeaders?: (binding: RemoteAgentBinding) => Promise<Record<string, string>>;
}): Promise<Response> {
  const url = new URL(input.request.url);
  const raw = url.searchParams.get("children");
  let children: DescendantHop[];
  try {
    if (raw === null || raw.length > 4096) throw new Error();
    const parsed: unknown = JSON.parse(raw);
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      parsed.length > DESCENDANT_MAX_DEPTH ||
      !parsed.every(
        (hop) =>
          hop !== null &&
          typeof hop === "object" &&
          typeof hop.sessionId === "string" &&
          hop.sessionId.length > 0 &&
          hop.sessionId.length <= 256 &&
          Number.isSafeInteger(hop.position) &&
          hop.position >= 0,
      )
    )
      throw new Error();
    children = parsed;
  } catch {
    return Response.json({ error: "Invalid descendant path.", ok: false }, { status: 400 });
  }
  const signal = AbortSignal.any([input.request.signal, AbortSignal.timeout(10_000)]);
  let parent = input.root;
  const ancestry = new Set([parent.id]);
  try {
    for (const [index, hop] of children.entries()) {
      const childId = hop.sessionId;
      const opened = await recordedChild(parent, hop, signal);
      if (opened === undefined) return unavailable();
      const remaining = children.slice(index + 1);
      if (opened.data.stream === createEveSessionStreamRoutePath(childId)) {
        if (ancestry.has(childId)) return unavailable("cycle", 422);
        ancestry.add(childId);
        parent = input.attachSession(childId);
        if (remaining.length !== 0) continue;
        const response = await createSessionStreamResponse(input.request, parent);
        response.headers.set(EVE_OBSERVATION_KEY_HEADER, localObservationKey(childId));
        return response;
      }
      const binding = await findRemoteAgentBinding({
        parent: internalSession(parent),
        callId: "callId" in opened.data.owner ? opened.data.owner.callId : "",
        childSessionId: childId,
        childStreamPath: opened.data.stream,
      });
      if (
        binding === undefined ||
        binding.earlierProtocol !== undefined ||
        input.resolveHeaders === undefined
      )
        return unavailable("unsupported", 422);
      const headers = await input.resolveHeaders(binding);
      const route =
        remaining.length === 0
          ? createEveSessionStreamRoutePath(childId)
          : createEveDescendantStreamRoutePath(childId);
      const upstreamUrl = new URL(route.replace(/^\/+/, ""), `${binding.url.replace(/\/+$/, "")}/`);
      for (const name of ["startIndex", "includeTailIndex", "follow"]) {
        const value = url.searchParams.get(name);
        if (value !== null) upstreamUrl.searchParams.set(name, value);
      }
      if (remaining.length !== 0)
        upstreamUrl.searchParams.set("children", JSON.stringify(remaining));
      const upstream = await fetch(upstreamUrl, {
        cache: "no-store",
        headers,
        redirect: "manual",
        signal,
      });
      if (upstream.status >= 300 && upstream.status < 400) {
        await upstream.body?.cancel();
        return unavailable("unsupported", 422);
      }
      const responseHeaders = proxyStreamHeaders(upstream.headers);
      if (upstream.ok) {
        const key =
          remaining.length === 0
            ? localObservationKey(childId)
            : upstream.headers.get(EVE_OBSERVATION_KEY_HEADER);
        if (key === null || key.length > 8192) {
          await upstream.body?.cancel();
          return unavailable("unsupported", 422);
        }
        responseHeaders.set(
          EVE_OBSERVATION_KEY_HEADER,
          JSON.stringify(["remote", parent.id, childId, key]),
        );
      }
      return new Response(upstream.body, { headers: responseHeaders, status: upstream.status });
    }
  } catch {
    return unavailable();
  }
  return unavailable();
}

function unavailable(code = "descendant_unavailable", status = 404): Response {
  return Response.json(
    { ok: false, code, error: "Descendant history is unavailable." },
    { status },
  );
}

async function recordedChild(
  parent: Session,
  hop: DescendantHop,
  signal: AbortSignal,
): Promise<ChildOpened | undefined> {
  signal.throwIfAborted();
  const lines = await internalSession(parent).getLineStream({
    follow: false,
    startIndex: hop.position,
  });
  const reader = lines.getReader();
  const cancel = () => void reader.cancel().catch(() => {});
  signal.addEventListener("abort", cancel, { once: true });
  const events = createEventReader();
  try {
    signal.throwIfAborted();
    const next = await reader.read();
    if (next.done) return undefined;
    return events
      .read(next.value as StoredLine, hop.position)
      .find(
        (event): event is Extract<typeof event, { type: "child.opened" }> =>
          event.type === "child.opened" && event.data.sessionId === hop.sessionId,
      );
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
  }
}

import { internalSession, type Session } from "#channel/session.js";
import type { ChildOpened } from "#protocol/session-events/families/child.js";
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
import { proxyStreamResponse } from "#eve-channel/stream-headers.js";
import { waitWithSignal } from "#shared/wait-with-signal.js";
import { isObject } from "#shared/guards.js";
import { isExpiredWorkflowRunError } from "#internal/workflow/is-inactive-workflow-run-error.js";

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
    const parsed = parseDescendantPath(JSON.parse(raw));
    if (parsed === undefined) throw new Error();
    children = parsed;
  } catch {
    return Response.json({ error: "Invalid descendant path.", ok: false }, { status: 400 });
  }
  const deadline = new AbortController();
  const timeout = setTimeout(
    () => deadline.abort(new DOMException("Reader resolution timed out.", "AbortError")),
    10_000,
  );
  const signal = AbortSignal.any([input.request.signal, deadline.signal]);
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
        const response = await resolvedResponse(
          createSessionStreamResponse(input.request, parent),
          signal,
        );
        response.headers.set(EVE_OBSERVATION_KEY_HEADER, localObservationKey(childId));
        return response;
      }
      const binding = await waitWithSignal(
        findRemoteAgentBinding({
          parent: internalSession(parent),
          callId: "callId" in opened.data.owner ? opened.data.owner.callId : "",
          childSessionId: childId,
          childStreamPath: opened.data.stream,
        }),
        signal,
      );
      if (
        binding === undefined ||
        binding.earlierProtocol !== undefined ||
        input.resolveHeaders === undefined
      )
        return unavailable("unsupported", 422);
      const headers = await waitWithSignal(input.resolveHeaders(binding), signal);
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
      const upstream = await resolvedResponse(
        fetch(upstreamUrl, {
          cache: "no-store",
          headers,
          redirect: "manual",
          signal,
        }),
        signal,
      );
      if (upstream.status >= 300 && upstream.status < 400) {
        void upstream.body?.cancel().catch(() => {});
        return unavailable("unsupported", 422);
      }
      const response = proxyStreamResponse(upstream);
      if (response.ok) {
        const key =
          remaining.length === 0
            ? localObservationKey(childId)
            : upstream.headers.get(EVE_OBSERVATION_KEY_HEADER);
        if (key === null || key.length > 8192) {
          void upstream.body?.cancel().catch(() => {});
          return unavailable("unsupported", 422);
        }
        response.headers.set(
          EVE_OBSERVATION_KEY_HEADER,
          JSON.stringify(["remote", parent.id, childId, key]),
        );
      }
      return response;
    }
  } catch (error) {
    if (isExpiredWorkflowRunError(error)) return unavailable("session_expired", 410);
    return unavailable();
  } finally {
    clearTimeout(timeout);
  }
  return unavailable();
}

function parseDescendantPath(value: unknown): DescendantHop[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > DESCENDANT_MAX_DEPTH)
    return undefined;
  const hops: readonly unknown[] = value;
  const path: DescendantHop[] = [];
  for (const hop of hops) {
    if (
      !isObject(hop) ||
      typeof hop.sessionId !== "string" ||
      hop.sessionId.length === 0 ||
      hop.sessionId.length > 256 ||
      typeof hop.position !== "number" ||
      !Number.isSafeInteger(hop.position) ||
      hop.position < 0
    )
      return undefined;
    path.push({ sessionId: hop.sessionId, position: hop.position });
  }
  return path;
}

async function resolvedResponse(
  pending: Promise<Response>,
  signal: AbortSignal,
): Promise<Response> {
  void pending.then(
    (response) => {
      if (signal.aborted) void response.body?.cancel().catch(() => {});
    },
    () => {},
  );
  return await waitWithSignal(pending, signal);
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
  const cancellation = new AbortController();
  const events = parent
    .stream({
      follow: false,
      startIndex: hop.position,
      signal: AbortSignal.any([signal, cancellation.signal]),
    })
    [Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await waitWithSignal(events.next(), signal);
      if (next.done || next.value.meta.position.line > hop.position) return undefined;
      const event = next.value;
      if (
        event.meta.position.line === hop.position &&
        event.type === "child.opened" &&
        event.data.sessionId === hop.sessionId
      )
        return event;
    }
  } finally {
    cancellation.abort();
    void events.return?.().catch(() => {});
  }
}

import { currentAgentHandoff, withAgentHandoff, type AgentHandoff } from "#tracing/lib/index.js";
const HANDOFF_BYTES = 8192;

const HEADER = "x-agent-tracing";
const encoder = new TextEncoder();
function isHexId(value: unknown, length: number): boolean {
  return (
    typeof value === "string" &&
    value.length === length &&
    /^[a-f0-9]+$/u.test(value) &&
    !/^0+$/u.test(value)
  );
}

/** Bind only to a client whose destinations the application has approved. */
function agentTraceFetch(fetcher: typeof fetch, maxBytes: number): typeof fetch {
  return (request, init) => {
    const handoff = currentAgentHandoff();
    if (handoff === undefined) return fetcher(request, init);
    const encoded = JSON.stringify(handoff);
    if (encoder.encode(encoded).length > maxBytes) return fetcher(request, init);
    const headers = new Headers(
      init?.headers ?? (request instanceof Request ? request.headers : undefined),
    );
    headers.set(HEADER, encoded);
    return fetcher(request, { ...init, headers, redirect: "error" });
  };
}

/** The host validates provenance; well-formed trace metadata is not authorization. */
function receiveAgentTrace<T>(
  headers: Headers,
  trusted: (handoff: AgentHandoff) => boolean,
  execute: (handoff?: AgentHandoff) => T,
  maxBytes: number,
): T {
  const encoded = headers.get(HEADER);
  if (encoded === null || encoded.length > maxBytes || encoder.encode(encoded).length > maxBytes)
    return execute();
  let handoff: AgentHandoff;
  const decode = (): AgentHandoff | undefined => {
    try {
      handoff = JSON.parse(encoded) as AgentHandoff;
      if (
        handoff === null ||
        typeof handoff !== "object" ||
        ![
          handoff.conversationId,
          handoff.parentRunId,
          handoff.parentCallId,
          handoff.agentName,
        ].every((value) => typeof value === "string" && value.length > 0 && value.length <= 1024)
      )
        return undefined;
      if (
        !isHexId(handoff.caller.traceId, 32) ||
        !isHexId(handoff.caller.spanId, 16) ||
        ![0, 1].includes(handoff.caller.traceFlags)
      )
        return undefined;
      if (
        handoff.caller.tracestate !== undefined &&
        (typeof handoff.caller.tracestate !== "string" || handoff.caller.tracestate.length > 512)
      )
        return undefined;
      if (
        ![handoff.capture.emit, handoff.capture.recordInputs, handoff.capture.recordOutputs].every(
          (value) => typeof value === "boolean",
        ) ||
        !trusted(handoff)
      )
        return undefined;
      return handoff;
    } catch {
      return undefined;
    }
  };
  const decoded = decode();
  if (decoded === undefined) return execute();
  const accepted = {
    ...decoded,
    capture: {
      emit: decoded.capture.emit && decoded.caller.traceFlags === 1,
      recordInputs:
        decoded.capture.emit && decoded.caller.traceFlags === 1 && decoded.capture.recordInputs,
      recordOutputs:
        decoded.capture.emit && decoded.caller.traceFlags === 1 && decoded.capture.recordOutputs,
    },
  };
  return withAgentHandoff(accepted, () => execute(accepted));
}

/** Host boundary for durable dispatch and authenticated remote transport. */
export function createAgentDelegationTransport(
  fetcher: typeof fetch = (request, init) => globalThis.fetch(request, init),
) {
  const maxBytes = HANDOFF_BYTES;
  return {
    fetch: agentTraceFetch(fetcher, maxBytes),
    transport: (fetcher: typeof fetch) => agentTraceFetch(fetcher, maxBytes),
    receive<T>(
      headers: Headers,
      trusted: (handoff: AgentHandoff) => boolean,
      execute: (handoff?: AgentHandoff) => T,
    ) {
      return receiveAgentTrace(headers, trusted, execute, maxBytes);
    },
    resume<T>(stored: AgentHandoff, execute: (handoff: AgentHandoff) => T): T {
      return withAgentHandoff(stored, () => execute(stored));
    },
  };
}

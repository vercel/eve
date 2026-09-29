import { readMessageStreamVersion } from "#client/stream-version.js";
import { deserializeContext } from "#context/serialize.js";
import { resolveRemoteAgentStreamHeaders } from "#execution/agent-sessions/remote.js";
import type { IndexedRecord, Source } from "#execution/run-observation/state.js";
import { EVE_STREAM_TAIL_INDEX_HEADER } from "#protocol/message.js";
import {
  normalizeMessageStreamEvent,
  type MessageStreamEventForVersion,
  type MessageStreamVersion,
} from "#protocol/message-version.js";
import {
  createEveSessionStreamRoutePath,
  createEveSubagentStreamRoutePath,
} from "#protocol/routes.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { createRemoteAgentRouteUrl } from "#subagents/remote-route-url.js";

const MAX_EVENTS = 200;
const MAX_BYTES = 512 * 1024;

/** A direct remote session may be read only via its recorded, authored resolver. */
export async function readRemoteObservationPage(input: {
  readonly serializedContext: Record<string, unknown>;
  readonly rootSessionId: string;
  readonly source: Source;
}): Promise<{
  readonly capturedTail: number;
  readonly records: readonly IndexedRecord[];
  readonly outcome: "page" | "caught-up" | "oversized" | "partial";
}> {
  "use step";
  const remote = input.source.remote;
  if (
    remote === undefined ||
    remote.resolverId === undefined ||
    input.source.parentKey !== input.rootSessionId ||
    input.source.callId === undefined ||
    input.source.streamPath !==
      createEveSubagentStreamRoutePath({
        parentSessionId: input.rootSessionId,
        callId: input.source.callId ?? "",
        childSessionId: input.source.sessionId,
      })
  ) {
    throw new Error("Remote observation requires an authored direct-child binding.");
  }
  const ctx = await deserializeContext(input.serializedContext);
  const bundle = ctx.require(BundleKey);
  const headers = await resolveRemoteAgentStreamHeaders({ bundle, ...remote });
  const url = new URL(
    createRemoteAgentRouteUrl(remote.url, createEveSessionStreamRoutePath(input.source.sessionId)),
  );
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname))
  ) {
    throw new Error("Remote observation requires an HTTPS agent endpoint.");
  }
  url.searchParams.set("startIndex", String(input.source.nextIndex));
  url.searchParams.set("includeTailIndex", "1");
  const response = await fetch(url, {
    headers,
    cache: "no-store",
    redirect: "manual",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok || response.body === null) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Remote observation stream unavailable (HTTP ${response.status}).`);
  }
  let version: MessageStreamVersion;
  try {
    version = readMessageStreamVersion(response.headers);
  } catch (error) {
    await response.body.cancel().catch(() => {});
    throw error;
  }
  const tailValue = response.headers.get(EVE_STREAM_TAIL_INDEX_HEADER);
  if (
    tailValue === null ||
    !/^-?\d+$/.test(tailValue) ||
    !Number.isSafeInteger(Number(tailValue))
  ) {
    await response.body.cancel().catch(() => {});
    throw new Error("Remote observation stream did not provide a valid captured tail.");
  }
  const capturedTail = Number(tailValue);
  const cursor = input.source.nextIndex;
  if (cursor > capturedTail + 1) {
    await response.body.cancel().catch(() => {});
    throw new Error("Remote observation tail is behind the saved cursor.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const records: IndexedRecord[] = [];
  let buffer = "";
  let bytes = 0;
  try {
    while (cursor + records.length <= capturedTail && records.length < MAX_EVENTS) {
      const result = await reader.read();
      if (result.done) {
        if (records.length > 0) return { capturedTail, records, outcome: "partial" };
        throw new Error("Remote observation ended before captured tail.");
      }
      bytes += result.value.byteLength;
      buffer += decoder.decode(result.value, { stream: true });
      for (
        let end = buffer.indexOf("\n");
        end !== -1 && cursor + records.length <= capturedTail && records.length < MAX_EVENTS;
        end = buffer.indexOf("\n")
      ) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        if (new TextEncoder().encode(line).byteLength > MAX_BYTES)
          return { capturedTail, records, outcome: "oversized" };
        const event = normalizeMessageStreamEvent(
          version,
          JSON.parse(line) as MessageStreamEventForVersion<MessageStreamVersion>,
        );
        records.push({ index: cursor + records.length, event });
      }
      if (bytes > MAX_BYTES) return { capturedTail, records, outcome: "oversized" };
    }
  } catch (error) {
    if (records.length > 0) return { capturedTail, records, outcome: "partial" };
    throw error;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return {
    capturedTail,
    records,
    outcome: cursor + records.length > capturedTail ? "caught-up" : "page",
  };
}

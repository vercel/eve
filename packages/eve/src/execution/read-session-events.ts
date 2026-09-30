import { parseTailIndexHeader } from "#client/open-stream.js";
import { readMessageStreamVersion } from "#client/stream-version.js";
import { loadContext } from "#context/container.js";
import { resolveRemoteAgentStreamHeaders } from "#execution/agent-sessions/remote.js";
import { parseNdjsonStream } from "#execution/ndjson-stream.js";
import { getRun } from "#internal/workflow/runtime.js";
import type { RemoteAgentBinding } from "#eve-channel/support.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import {
  normalizeMessageStreamEvent,
  normalizePersistedMessageStreamEvent,
  type MessageStreamEventForVersion,
  type MessageStreamVersion,
} from "#protocol/message-version.js";
import { createEveSessionStreamRoutePath } from "#protocol/routes.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { createRemoteAgentRouteUrl } from "#subagents/remote-route-url.js";

const READ_TIMEOUT_MS = 5_000;

/** A bounded run of a session's stream events, and where the next read starts. */
export interface SessionEventsPage {
  readonly events: readonly MessageStreamEvent[];
  readonly nextIndex: number;
  /** Whether the page reached the stream's tail as it stood when the read began. */
  readonly caughtUp: boolean;
}

/** Where a remote agent's session runs, as its `agent.started` recorded it. */
export type RemoteSessionBinding = Pick<RemoteAgentBinding, "name" | "resolverId" | "url">;

/**
 * Reads at most `limit` events of a session's stream from `startIndex`, never
 * past the tail it saw at the start, so reading a parked session never waits
 * for events it hasn't written. A remote session is read from its own
 * deployment with the remote agent's credentials, which needs the running
 * session's context.
 */
export async function readSessionEvents(input: {
  readonly limit: number;
  readonly remote?: RemoteSessionBinding | undefined;
  readonly sessionId: string;
  readonly startIndex: number;
}): Promise<SessionEventsPage> {
  return input.remote === undefined
    ? await readLocalSessionEvents(input)
    : await readRemoteSessionEvents({ ...input, remote: input.remote });
}

async function readLocalSessionEvents(input: {
  readonly limit: number;
  readonly sessionId: string;
  readonly startIndex: number;
}): Promise<SessionEventsPage> {
  const run = getRun(input.sessionId);
  const probe = run.getReadable();
  let tailIndex: number;
  try {
    tailIndex = await probe.getTailIndex();
  } finally {
    await probe.cancel().catch(() => {});
  }
  if (tailIndex < input.startIndex) {
    return { caughtUp: true, events: [], nextIndex: input.startIndex };
  }
  return await readPage(
    input,
    tailIndex,
    parseNdjsonStream<MessageStreamEvent>(
      () => run.getReadable({ startIndex: input.startIndex }),
      (value) =>
        normalizePersistedMessageStreamEvent(
          value as MessageStreamEventForVersion<MessageStreamVersion>,
        ),
    ),
  );
}

async function readRemoteSessionEvents(input: {
  readonly limit: number;
  readonly remote: RemoteSessionBinding;
  readonly sessionId: string;
  readonly startIndex: number;
}): Promise<SessionEventsPage> {
  // Without a resolver there are no credentials, and no bundle to look them up in.
  const headers =
    input.remote.resolverId === undefined
      ? {}
      : await resolveRemoteAgentStreamHeaders({
          bundle: loadContext().require(BundleKey),
          ...input.remote,
        });
  const url = new URL(
    createRemoteAgentRouteUrl(input.remote.url, createEveSessionStreamRoutePath(input.sessionId)),
  );
  url.searchParams.set("startIndex", String(input.startIndex));
  // The receiver ends the stream at the tail it reports, so the read never waits on a live session.
  url.searchParams.set("includeTailIndex", "1");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers,
      redirect: "error",
      signal: controller.signal,
    });
    const body = response.body;
    let tailIndex: number | undefined;
    let version: MessageStreamVersion;
    try {
      if (!response.ok || body === null) {
        throw new Error(
          `Remote agent "${input.remote.name}" session stream read failed with HTTP ${response.status}.`,
        );
      }
      tailIndex = parseTailIndexHeader(response.headers);
      if (tailIndex === undefined) {
        throw new Error(
          `Remote agent "${input.remote.name}" session stream did not report its tail index.`,
        );
      }
      version = readMessageStreamVersion(response.headers);
    } catch (error) {
      await body?.cancel().catch(() => {});
      throw error;
    }
    return await readPage(
      input,
      tailIndex,
      parseNdjsonStream<MessageStreamEvent>(
        () => body,
        (value) =>
          normalizeMessageStreamEvent(
            version,
            value as MessageStreamEventForVersion<MessageStreamVersion>,
          ),
      ),
    );
  } finally {
    clearTimeout(timer);
  }
}

async function readPage(
  input: { readonly limit: number; readonly startIndex: number },
  tailIndex: number,
  stream: ReadableStream<MessageStreamEvent>,
): Promise<SessionEventsPage> {
  const last = Math.min(tailIndex, input.startIndex + input.limit - 1);
  const reader = stream.getReader();
  const events: MessageStreamEvent[] = [];
  try {
    while (input.startIndex + events.length <= last) {
      const next = await readWithin(reader, READ_TIMEOUT_MS);
      if (next.done) break;
      events.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const nextIndex = input.startIndex + events.length;
  return { caughtUp: nextIndex > tailIndex, events, nextIndex };
}

async function readWithin<T>(
  reader: ReadableStreamDefaultReader<T>,
  ms: number,
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<T>["read"]>>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Session stream read timed out.")), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

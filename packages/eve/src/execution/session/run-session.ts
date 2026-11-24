import {
  lineWritable,
  reveal,
  type SessionStartInput,
  type SessionStreamSink,
} from "#execution/durable.js";
import type { SessionStartBody } from "#execution/session-runtime.js";
import { createSessionInbox, type SessionInboxTransport } from "#execution/session-inbox/inbox.js";
import { bootFromCheckpoint } from "#execution/session/checkpoint-boot.js";
import { clockSessionTimeoutControl } from "#execution/session/clock-timeout.js";
import { assertRecordSessionCode } from "#execution/session/session-code.js";
import { SESSION_CHECKPOINT_VERSION } from "#execution/session/checkpoint.js";
import { sessionHookTokens } from "#execution/session/hook-tokens.js";
import { bootInitialOwner, type BootOutcome } from "#execution/session/owner-boot.js";
import {
  startPreparedSession,
  type AdoptRecord,
  type ProgramHost,
  type SessionRunResult,
} from "#execution/session/program.js";
import {
  openSessionRecord,
  type SessionRecord,
  type SessionRecordContents,
} from "#execution/session/record.js";
import { DEFAULT_SESSION_TIMEOUT_MS } from "#execution/session/timeout.js";
import type { SessionCapabilities } from "#channel/types.js";

/** The session that {@link runSession} runs. */
export interface SessionRun {
  /** The ID of the session. */
  readonly sessionId: string;
  /** The start that `Durable.start()` received for the session. */
  readonly start: SessionStartInput;
  /** The last record of the session, or none at its first run. */
  readonly record?: SessionRecord;
}

/** The host of {@link runSession}, which a durable engine gives. */
export interface RunSessionHost extends ProgramHost {
  /** Keeps each record of the session. */
  readonly adopted: AdoptRecord;
  /** The ID of the deployment that runs the session. */
  readonly deploymentId: string;
  /** The inbox of the session. Make it with `sessionInbox()`. */
  readonly inbox: SessionInboxTransport;
  /** Where the stream lines of the session go. */
  readonly stream: SessionStreamSink;
}

function sessionWritable(sink: SessionStreamSink, sessionId: string): WritableStream<Uint8Array> {
  return lineWritable({
    write: async (lines) => await sink.append(sessionId, (await sink.tail(sessionId)) + 1, lines),
    close: () => sink.close(sessionId),
  });
}

/**
 * Runs the session program of eve for one session, until it ends, parks, or moves. A durable engine
 * calls it from its own durable function, and runs it again from the record of a parked session.
 * It throws `SessionCodeMismatchError` before it changes anything when another session code wrote
 * the record.
 */
export async function runSession(run: SessionRun, host: RunSessionHost): Promise<SessionRunResult> {
  if (run.record !== undefined) assertRecordSessionCode(run.sessionId, run.record);
  const { entry } = reveal<SessionStartBody>(run.start.body);
  const stream = sessionWritable(host.stream, run.sessionId);
  const booted =
    run.record === undefined
      ? await bootInitialOwner({ ...entry, ownerDeploymentId: host.deploymentId }, run.sessionId, {
          all: host.all,
          inboxTransport: host.inbox,
          sessionWritable: stream,
          settleContinuationConflict: async () => {},
          step: host.step,
          timeouts: (input) => clockSessionTimeoutControl(host.now, input),
        })
      : await bootFromRecord(run.sessionId, openSessionRecord(run.record), entry, host, stream);
  if (booted === undefined) return { kind: "ended", outcome: "cancelled" };
  return await startPreparedSession(booted.session, booted.inbox, host, (record, consumed) =>
    host.adopted(record, consumed),
  ).result;
}

async function bootFromRecord(
  sessionId: string,
  record: SessionRecordContents,
  entry: SessionStartBody["entry"],
  host: RunSessionHost,
  stream: WritableStream<Uint8Array>,
): Promise<BootOutcome> {
  const { open, transfer, timeoutDeadline } = record;
  const sessionTimeoutMs = entry.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
  const sessionTimeoutControl = clockSessionTimeoutControl(host.now, {
    sessionId,
    timeoutMs: sessionTimeoutMs,
    ...(timeoutDeadline !== undefined && { deadline: new Date(timeoutDeadline) }),
  });
  const inbox = createSessionInbox(host.inbox);
  await inbox.claimSessionHooks(sessionHookTokens(transfer));
  const session = bootFromCheckpoint(
    {
      ...transfer,
      capabilities: transfer.serializedContext["eve.capabilities"] as
        | SessionCapabilities
        | undefined,
      retention: entry.retention,
      sessionTimeoutMs,
      version: SESSION_CHECKPOINT_VERSION,
    },
    {
      anchor: { kind: "self" },
      deploymentId: host.deploymentId,
      serializedContext: transfer.serializedContext,
      sessionId,
      sessionWritable: stream,
      ...(sessionTimeoutControl !== undefined && { sessionTimeoutControl }),
      ...(open !== undefined && { rerunFirst: true, start: { kind: "resume", from: open } }),
    },
  );
  return { inbox, session: { ...session, generation: record.generation } };
}

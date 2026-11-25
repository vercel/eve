import {
  lineWritable,
  reveal,
  type SessionContentStore,
  type SessionStartInput,
  type SessionStreamSink,
} from "#execution/durable.js";
import type { SessionStartBody } from "#execution/session-runtime.js";
import { createSessionInbox, type SessionInboxTransport } from "#execution/session-inbox/inbox.js";
import { bootFromCheckpoint } from "#execution/session/checkpoint-boot.js";
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
  restoreSessionRecord,
  type SessionRecord,
  type SessionRecordContents,
} from "#execution/session/record.js";
import { DEFAULT_SESSION_TIMEOUT_MS } from "#execution/session/timeout.js";
import type { SessionCapabilities } from "#channel/types.js";

export interface SessionRun {
  readonly sessionId: string;
  readonly start: SessionStartInput;
  readonly record?: SessionRecord;
}

export interface RunSessionHost extends ProgramHost {
  readonly adopted: AdoptRecord;
  readonly deploymentId: string;
  readonly inbox: SessionInboxTransport;
  readonly stream: SessionStreamSink;
  readonly content?: SessionContentStore;
}

function sessionWritable(sink: SessionStreamSink, sessionId: string): WritableStream<Uint8Array> {
  return lineWritable({
    write: async (lines) => await sink.append(sessionId, (await sink.tail(sessionId)) + 1, lines),
    close: () => sink.close(sessionId),
  });
}

export async function runSession(run: SessionRun, host: RunSessionHost): Promise<SessionRunResult> {
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
          timeouts: () => undefined,
        })
      : await bootFromRecord(
          run.sessionId,
          await restoreSessionRecord(
            run.record,
            host.content === undefined
              ? undefined
              : { content: host.content, sessionId: run.sessionId },
          ),
          entry,
          host,
          stream,
        );
  if (booted === undefined) return { kind: "ended", outcome: "cancelled" };
  return await startPreparedSession(
    booted.session,
    booted.inbox,
    host,
    (record, consumed) => host.adopted(record, consumed),
    host.content,
  ).result;
}

async function bootFromRecord(
  sessionId: string,
  record: SessionRecordContents,
  entry: SessionStartBody["entry"],
  host: RunSessionHost,
  stream: WritableStream<Uint8Array>,
): Promise<BootOutcome> {
  const { open, transfer } = record;
  const inbox = createSessionInbox(host.inbox);
  await inbox.claimSessionHooks(sessionHookTokens(transfer));
  const session = bootFromCheckpoint(
    {
      ...transfer,
      capabilities: transfer.serializedContext["eve.capabilities"] as
        | SessionCapabilities
        | undefined,
      retention: entry.retention,
      sessionTimeoutMs: entry.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS,
      version: SESSION_CHECKPOINT_VERSION,
    },
    {
      anchor: { kind: "self" },
      deploymentId: host.deploymentId,
      serializedContext: transfer.serializedContext,
      sessionId,
      sessionWritable: stream,
      ...(open !== undefined && { rerunFirst: true, start: { kind: "resume", from: open } }),
    },
  );
  return { inbox, session: { ...session, generation: record.generation } };
}

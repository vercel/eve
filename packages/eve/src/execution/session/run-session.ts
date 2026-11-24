import { reveal, type SessionStartInput } from "#execution/durable.js";
import type { SessionStartBody } from "#execution/session-runtime.js";
import { createSessionInbox, type SessionInboxTransport } from "#execution/session-inbox/inbox.js";
import { bootFromCheckpoint } from "#execution/session/checkpoint-boot.js";
import { SESSION_CHECKPOINT_VERSION } from "#execution/session/checkpoint.js";
import { sessionHookTokens } from "#execution/session/hook-tokens.js";
import { bootInitialOwner, type BootOutcome } from "#execution/session/owner-boot.js";
import {
  startPreparedSession,
  type SessionHost,
  type SessionRunResult,
} from "#execution/session/program.js";
import {
  openSessionRecord,
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

export interface SessionRunHost extends SessionHost {
  adopted(record: SessionRecord, consumed: { readonly throughSeq: number }): Promise<void>;
  readonly deploymentId: string;
  readonly inbox: SessionInboxTransport;
  readonly stream: WritableStream<Uint8Array>;
}

export async function runSession(run: SessionRun, host: SessionRunHost): Promise<SessionRunResult> {
  const { entry } = reveal<SessionStartBody>(run.start.body);
  const booted =
    run.record === undefined
      ? await bootInitialOwner({ ...entry, ownerDeploymentId: host.deploymentId }, run.sessionId, {
          all: host.all,
          inboxTransport: host.inbox,
          sessionWritable: host.stream,
          settleContinuationConflict: async () => {},
          step: host.step,
          timeouts: () => undefined,
        })
      : await bootFromRecord(run.sessionId, openSessionRecord(run.record), entry, host);
  if (booted === undefined) return { kind: "ended", outcome: "cancelled" };
  return await startPreparedSession(booted.session, booted.inbox, host).result;
}

async function bootFromRecord(
  sessionId: string,
  record: SessionRecordContents,
  entry: SessionStartBody["entry"],
  host: SessionRunHost,
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
      sessionWritable: host.stream,
      ...(open !== undefined && { rerunFirst: true, start: { kind: "resume", from: open } }),
    },
  );
  return { inbox, session: { ...session, generation: record.generation } };
}

import type { SessionCommand } from "#channel/types.js";
import {
  SESSION_CHECKPOINT_VERSION,
  type SessionCheckpoint,
} from "#execution/session/checkpoint.js";
import {
  recordOf,
  type SessionBoot,
  type SessionRecord,
  type SessionRecorder,
} from "#execution/session/program.js";
import { storedProjection } from "#harness/session-machine/view.js";
import type { SessionView } from "#protocol/session-projection/tables.js";
import type { AcceptedInput, SessionState, SessionStore } from "./session-store.js";
import { SESSION_SNAPSHOT_FORMAT, type SessionSnapshot } from "./snapshot.js";

// What an in-process runtime keeps of one session it runs, beyond what the session's loop holds:
// the loop's last record (`SessionRecorder`) and the inputs it accepted and hasn't read. With a
// store, it saves the session at every record, and keeps each input before its address accepts
// it; another process continues the session from there.

export interface HostedSessionInput {
  /** The session as it boots, which is its record until the loop records it. */
  readonly boot: SessionBoot;
  /** What an earlier process accepted and no saved step read: a restored session's. */
  readonly inputs?: SessionSnapshot["inputs"];
  /** Its stream as recorded so far, one line each. */
  readonly lines: () => readonly string[];
  /** Resolves once every line its stream wrote so far is kept, which a save waits for. */
  readonly flushLines?: () => Promise<void>;
  readonly store?: SessionStore;
  /** Whether its host suspended it; see `SessionRecorder.suspended`. */
  readonly suspended: () => boolean;
}

export class HostedSession implements SessionRecorder {
  private readonly input: HostedSessionInput;
  private record: SessionRecord;
  private readonly unread: AcceptedInput[];
  private nextSeq: number;

  constructor(input: HostedSessionInput) {
    this.input = input;
    this.record = recordOf(input.boot);
    this.unread = [...(input.inputs?.unread ?? [])];
    this.nextSeq = input.inputs?.next ?? 0;
  }

  suspended(): boolean {
    return this.input.suspended();
  }

  async adopted(record: SessionRecord): Promise<void> {
    this.record = record;
    const { deliveries } = projectionOf(record).view;
    for (let index = this.unread.length - 1; index >= 0; index--)
      if (isRead(deliveries[deliveryIdOf(this.unread[index]!.command) ?? ""]))
        this.unread.splice(index, 1);
    await this.save();
  }

  /** Keeps `command`, sent to `token`, before the address accepts it; one without a delivery id is not kept. */
  async accept(token: string, command: SessionCommand): Promise<void> {
    if (deliveryIdOf(command) === undefined) return;
    const input: AcceptedInput = { command, seq: this.nextSeq++, token };
    this.unread.push(input);
    await this.input.store?.appendInput(this.input.boot.sessionId, input);
  }

  /** The session as a store saves it: everything but its lines. */
  state(): SessionState {
    const checkpoint = this.checkpoint();
    const unreadKeys = new Set(this.unread.flatMap(({ command }) => idempotencyKeyOf(command)));
    const { open } = this.record;
    const timeout = this.input.boot.sessionTimeoutControl;
    return {
      // Kept inputs go back through the queue on restore, which would drop them as duplicates.
      checkpoint: {
        ...checkpoint,
        admittedDeliveryKeys: checkpoint.admittedDeliveryKeys.filter((key) => !unreadKeys.has(key)),
      },
      format: SESSION_SNAPSHOT_FORMAT,
      sessionId: this.input.boot.sessionId,
      takenAt: new Date().toISOString(),
      ...(open !== undefined && { open }),
      ...((this.unread.length > 0 || this.nextSeq > 0) && {
        inputs: { next: this.nextSeq, unread: [...this.unread] },
      }),
      ...(timeout !== undefined && { deadline: timeout.getDeadline().toISOString() }),
    };
  }

  snapshot(): SessionSnapshot {
    return { ...this.state(), lines: [...this.input.lines()] };
  }

  /** Saves the session, when a store keeps it. */
  async save(): Promise<void> {
    // A saved step's position counts every line it wrote: they're kept first.
    await this.input.flushLines?.();
    await this.input.store?.saveState(this.state());
  }

  private checkpoint(): SessionCheckpoint {
    const { capabilities, retention, sessionTimeoutMs } = this.input.boot;
    return {
      ...this.record.transfer,
      sessionTimeoutMs,
      version: SESSION_CHECKPOINT_VERSION,
      ...(capabilities !== undefined && { capabilities }),
      ...(retention !== undefined && { retention }),
    };
  }
}

function projectionOf(record: SessionRecord) {
  return storedProjection(record.transfer.sessionState.snapshot.session.state);
}

/** A delivery the session consumed or settled: a step it saved read it. */
function isRead(row: SessionView["deliveries"][string] | undefined): boolean {
  return row !== undefined && row.status !== "admitted";
}

/** The delivery `command` arrives as, which the step that reads it records. */
export function deliveryIdOf(command: SessionCommand): string | undefined {
  switch (command.kind) {
    case "send":
      return command.delivery?.deliveryId;
    case "prewarm":
      return undefined;
    default:
      return command.deliveryId;
  }
}

function idempotencyKeyOf(command: SessionCommand): string[] {
  return command.kind === "send" && command.idempotencyKey !== undefined
    ? [command.idempotencyKey]
    : [];
}

import { deliveriesReadBy } from "#execution/session/open-turn.js";
import type { SessionCommand } from "#channel/types.js";
import { runMessagesIn, type WorkflowToolRunMessage } from "#execution/tools/workflow/messages.js";
import { createLogger, logError } from "#internal/logging.js";
import { checksSessionEvents } from "#shared/dev-checks.js";
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
import type { Arrival } from "./inbox-transport.js";
import { runRecordOf, type RunSnapshot } from "./runs.js";
import {
  heardWith,
  type AcceptedInput,
  type SessionState,
  type SessionStore,
} from "./session-store.js";
import { SESSION_SNAPSHOT_FORMAT, type SessionSnapshot } from "./snapshot.js";

// What an in-process runtime keeps of one session it runs, beyond what the session's loop holds:
// the loop's last record (`SessionRecorder`), the inputs it accepted and hasn't read, and the runs
// it hasn't heard the end of. With a store, it saves the session at every record, and keeps each
// input before its address accepts it (`keep`); another process continues the session from there.

const log = createLogger("execution.in-process.session-record");

export interface HostedSessionInput {
  /** The session as it boots, which is its record until the loop records it. */
  readonly boot: SessionBoot;
  /** What an earlier process accepted and no saved step read: a restored session's. */
  readonly inputs?: SessionSnapshot["inputs"];
  /** Its stream as recorded so far, one line each. */
  readonly lines: () => readonly string[];
  /** Resolves once every line its stream wrote so far is kept, which a save waits for. */
  readonly flushLines?: () => Promise<void>;
  /** The runs it started that it hasn't heard the end of, by what `heard` says it read. */
  readonly runs: (heard: (run: RunSnapshot) => boolean) => readonly RunSnapshot[];
  /** Runs an earlier process left, which report as interrupted until the session reads that. */
  readonly lostRuns?: readonly RunSnapshot[];
  readonly store?: SessionStore;
  /** Whether its host suspended it; see `SessionRecorder.suspended`. */
  readonly suspended: () => boolean;
}

export class HostedSession implements SessionRecorder {
  private readonly input: HostedSessionInput;
  private record: SessionRecord;
  private readonly unread: AcceptedInput[];
  /** How many messages each run sent, read or not; see `SessionSnapshot.inputs.heard`. */
  private heard: Readonly<Record<string, number>> | undefined;
  /**
   * The run messages among `unread`, as the session's inbox holds them: the loop names those it
   * read by the same objects (`SessionRecord.consumed`).
   */
  private readonly keptMessages = new WeakMap<WorkflowToolRunMessage, AcceptedInput>();
  private nextSeq: number;

  constructor(input: HostedSessionInput) {
    this.input = input;
    this.record = recordOf(input.boot);
    this.unread = [...(input.inputs?.unread ?? [])];
    this.heard = input.inputs?.heard;
    for (const kept of this.unread)
      if ("runMessage" in kept) this.keptMessages.set(kept.runMessage, kept);
    this.nextSeq = input.inputs?.next ?? 0;
  }

  suspended(): boolean {
    return this.input.suspended();
  }

  async adopted(record: SessionRecord): Promise<void> {
    this.record = record;
    const { deliveries } = projectionOf(record).view;
    const consumed = new Set(record.consumed.flatMap((message) => this.keptOf(message)));
    // What the step it runs reads: the record holds it from now on, in that step and in the turn
    // it leaves paused, so it's read even before the session consumes it.
    const reading = new Set(deliveriesReadBy(record.open));
    for (let index = this.unread.length - 1; index >= 0; index--) {
      const input = this.unread[index]!;
      const id = "command" in input ? (deliveryIdOf(input.command) ?? "") : undefined;
      const read =
        id !== undefined ? isRead(deliveries[id]) || reading.has(id) : consumed.has(input);
      if (read) this.unread.splice(index, 1);
    }
    await this.save();
  }

  /**
   * Keeps what arrived at `token` before the session's address queues it: a command with a
   * delivery id, or the messages a run sent. Anything else isn't kept.
   */
  readonly keep = async (token: string, arrival: Arrival): Promise<void> => {
    const messages = runMessagesIn(arrival);
    if (messages.length > 0) {
      await this.acceptRunMessages(token, messages);
      return;
    }
    const command = commandOf(arrival);
    if (command !== undefined && deliveryIdOf(command) !== undefined)
      await this.append({ command, seq: this.nextSeq++, token });
  };

  private async acceptRunMessages(
    token: string,
    messages: readonly WorkflowToolRunMessage[],
  ): Promise<void> {
    for (const runMessage of messages) {
      const input: AcceptedInput = { runMessage, seq: this.nextSeq++, token };
      this.keptMessages.set(runMessage, input);
      this.heard = heardWith(this.heard, [input]);
      await this.append(input);
    }
  }

  private async append(input: AcceptedInput): Promise<void> {
    this.unread.push(input);
    await this.input.store?.appendInput(this.input.boot.sessionId, input);
  }

  /**
   * The kept input the loop read as `message`. Every run message the loop reads came through
   * `keep`, so one that didn't is a bug: a layer copied it, and a restore would deliver it again.
   */
  private keptOf(message: WorkflowToolRunMessage): AcceptedInput[] {
    const kept = this.keptMessages.get(message);
    if (kept !== undefined) return [kept];
    const error = new Error(
      `The session read a "${message.kind}" message from run "${message.from.runId}" it never kept.`,
    );
    if (checksSessionEvents()) throw error;
    logError(log, "a consumed run message was never kept", error);
    return [];
  }

  /** The session as a store saves it: everything but its lines. */
  state(): SessionState {
    const checkpoint = this.checkpoint();
    const { calls, tasks } = projectionOf(this.record).view;
    const unreadKeys = new Set(
      this.unread.flatMap((input) => ("command" in input ? idempotencyKeyOf(input.command) : [])),
    );
    // A run's end is heard once the session settled its call, or ended its task.
    const heard = (run: RunSnapshot) => {
      const { callId, taskId } = runRecordOf(run);
      return taskId === undefined
        ? calls[callId]?.status === "settled"
        : tasks[taskId]?.status === "ended";
    };
    const runs = [
      ...(this.input.lostRuns ?? []).filter((run) => !heard(run)),
      ...this.input.runs(heard),
    ];
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
        inputs: {
          next: this.nextSeq,
          unread: [...this.unread],
          ...(this.heard !== undefined && { heard: this.heard }),
        },
      }),
      ...(timeout !== undefined && { deadline: timeout.getDeadline().toISOString() }),
      ...(runs.length > 0 && { runs }),
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

/** `arrival` as a command a session takes, if it's one. */
function commandOf(arrival: Arrival): SessionCommand | undefined {
  switch (arrival.kind) {
    case "send":
    case "cancel":
    case "reset":
      return arrival;
    // A route's `compact` or `clear` carries no delivery; a command's does.
    case "compact":
    case "clear":
      return "deliveryId" in arrival ? arrival : undefined;
    default:
      return undefined;
  }
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

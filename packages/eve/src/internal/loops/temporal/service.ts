import type { HandleMessageStreamEvent } from "#protocol/message.js";
import { InMemoryLoopEventLog, type LoopEventPublication } from "#internal/loops/event-log.js";
import { TemporalLoopAddressStore, type TemporalLoopAddress } from "./address-store.js";

/** Shared process-local state used by the local Temporal client and Worker. */
export class TemporalLoopService {
  readonly #addresses = new TemporalLoopAddressStore();
  readonly #eventLogs = new Map<string, InMemoryLoopEventLog>();

  begin(input: {
    readonly continuationToken: string;
    readonly sessionId: string;
    readonly workflowId: string;
  }): void {
    this.#addresses.begin({
      continuationToken: input.continuationToken,
      sessionId: input.sessionId,
      workflowId: input.workflowId,
    });
    this.#eventLogs.set(input.sessionId, new InMemoryLoopEventLog());
  }

  attachRun(input: { readonly runId: string; readonly sessionId: string }): void {
    this.#addresses.attachRun(input);
  }

  appendEvent(sessionId: string, publication: LoopEventPublication): void {
    this.#requireEventLog(sessionId).append(publication);
  }

  rekey(input: { readonly continuationToken: string; readonly sessionId: string }): void {
    this.#addresses.rekey(input);
  }

  resolve(continuationToken: string): TemporalLoopAddress | null {
    return this.#addresses.resolve(continuationToken);
  }

  stream(sessionId: string, startIndex = 0): ReadableStream<HandleMessageStreamEvent> {
    return this.#requireEventLog(sessionId).stream(startIndex);
  }

  settle(sessionId: string): void {
    if (!this.#addresses.settle(sessionId)) return;
    this.#requireEventLog(sessionId).close();
  }

  fail(sessionId: string, error: unknown): void {
    if (!this.#addresses.settle(sessionId)) return;
    this.#requireEventLog(sessionId).fail(error);
  }

  #requireEventLog(sessionId: string): InMemoryLoopEventLog {
    const eventLog = this.#eventLogs.get(sessionId);
    if (eventLog === undefined)
      throw new Error(`Unknown Temporal loop runtime session "${sessionId}".`);
    return eventLog;
  }
}

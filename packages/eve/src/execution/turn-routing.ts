import type { DeliverHookPayload } from "#channel/types.js";
import { cancelAllIndexedSessionTasksStep } from "#execution/cancel-indexed-session-tasks-step.js";
import { reportDroppedWirePayloadStep } from "#execution/report-dropped-wire-payload-step.js";
import { routeDeliverToChildren } from "#execution/route-child-delivery.js";
import type { SessionInbox, SessionInboxPayload } from "#execution/session-inbox/inbox.js";
import type { SessionExecutionCursor } from "#execution/session-execution-cursor.js";
import type { RuntimeActionResultStepInput } from "#execution/turn-step.js";
import {
  decodeSessionInboxPayload,
  SessionInboxPayloadError,
} from "#execution/session-inbox/protocol.js";
import { coalesceDeliveries } from "#harness/messages.js";
import { TurnCancelledError } from "#harness/turn-cancellation.js";
import { findRunningAgentHandle } from "#subagents/handles/query.js";
import { runProxySubagentEventStep } from "#subagents/event-proxy-step.js";

interface TurnCancelPayload {
  readonly tasks?: boolean;
  readonly turnId?: string;
}

/** Routes session messages against a turn's committed state. The session inbox
 * retains arrivals until a boundary; this object owns no transport queue. */
export class TurnRouting {
  private readonly admittedDeliveries = new Set<DeliverHookPayload>();
  private readonly runtimeResults: RuntimeActionResultStepInput[] = [];
  private readonly caller: DeliverHookPayload["caller"];
  private readonly bufferedDeliveries: DeliverHookPayload[];
  private readonly bufferedSessionControls: Array<"clear" | "compact" | "expired" | "reset">;
  private readonly cancelledTaskIds: Set<string>;
  private readonly commandInbox: SessionInbox;
  private readonly controller = new AbortController();
  private readonly cursor: SessionExecutionCursor;
  private readonly expectedTurnId: string;
  private readonly seenTaskDeliveries: Set<string>;
  private currentCancellation: TurnCancelPayload | undefined;

  constructor(input: {
    readonly bufferedDeliveries: DeliverHookPayload[];
    readonly bufferedSessionControls: Array<"clear" | "compact" | "expired" | "reset">;
    readonly cancelledTaskIds: Set<string>;
    readonly commandInbox: SessionInbox;
    readonly cursor: SessionExecutionCursor;
    readonly expectedTurnId: string;
    readonly seenTaskDeliveries: Set<string>;
    readonly caller: DeliverHookPayload["caller"];
  }) {
    this.bufferedDeliveries = input.bufferedDeliveries;
    this.bufferedSessionControls = input.bufferedSessionControls;
    this.cancelledTaskIds = input.cancelledTaskIds;
    this.commandInbox = input.commandInbox;
    this.cursor = input.cursor;
    this.expectedTurnId = input.expectedTurnId;
    this.seenTaskDeliveries = input.seenTaskDeliveries;
    this.caller = input.caller;
  }

  takeSteering(): DeliverHookPayload | undefined {
    const admitted: DeliverHookPayload[] = [];
    const queued: DeliverHookPayload[] = [];
    for (const delivery of this.bufferedDeliveries) {
      if (
        this.admittedDeliveries.has(delivery) &&
        delivery.taskDeliveryId === undefined &&
        (delivery.turnPolicy ?? "steer") === "steer" &&
        (delivery.caller === undefined || delivery.caller.callId === this.caller?.callId)
      )
        admitted.push(delivery);
      else queued.push(delivery);
    }
    this.bufferedDeliveries.splice(0, this.bufferedDeliveries.length, ...queued);
    for (const delivery of admitted) this.admittedDeliveries.delete(delivery);
    return admitted.length === 0 ? undefined : coalesceDeliveries(admitted);
  }

  async admitBoundary(): Promise<void> {
    const pending = this.commandInbox.drain();
    for (const [index, payload] of pending.entries()) {
      if (this.signal.aborted) {
        this.commandInbox.restore(pending.slice(index));
        return;
      }
      await this.handle(payload, true);
    }
  }

  takeRuntimeResult(): RuntimeActionResultStepInput | undefined {
    return this.runtimeResults.shift();
  }

  get cancellation(): TurnCancelPayload | undefined {
    return this.currentCancellation;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  async waitFor<T>(operation: Promise<T>): Promise<T> {
    const settled = operation.then((value) => ({ kind: "operation" as const, value }));
    while (true) {
      const winner = await Promise.race([
        settled,
        this.commandInbox
          .next("interrupt")
          .then((result) => ({ kind: "command" as const, result })),
      ]);
      if (winner.kind === "operation") return winner.value;
      if (winner.result.done) {
        throw new Error("Session command inbox closed before the active turn settled.");
      }
      this.commandInbox.consumeNext("interrupt");
      const payload = winner.result.value;
      await this.handle(payload, false);
    }
  }

  async handle(
    value: SessionInboxPayload,
    routeDeliveries: boolean,
  ): Promise<"cancel-turn" | void> {
    if (value.kind === "runtime-action-result") {
      this.runtimeResults.push({ kind: "runtime-action-result", results: value.results });
      return;
    }
    if (value.kind === "subagent-input-request" || value.kind === "subagent-authorization-event") {
      const handle = findRunningAgentHandle(this.cursor.sessionState.snapshot.session.state, {
        callId: value.callId,
      });
      if (
        handle?.identity.name !== value.subagentName ||
        handle.address.sessionId !== value.childSessionId
      ) {
        return;
      }
      await this.cursor.adopt(
        await runProxySubagentEventStep({
          hookPayload: value,
          parentWritable: this.cursor.parentWritable,
          serializedContext: this.cursor.serializedContext,
          sessionState: this.cursor.sessionState,
        }),
      );
      return;
    }
    let command;
    try {
      command = decodeSessionInboxPayload(value);
    } catch (error) {
      if (!(error instanceof SessionInboxPayloadError)) throw error;
      await reportDroppedWirePayloadStep({ detail: error.message, family: "session-inbox" });
      return;
    }

    if (command.kind === "deliver") {
      if (!this.acceptTaskDelivery(command)) return;
      let delivery: DeliverHookPayload | undefined = command;
      if (routeDeliveries) {
        const routed = await routeDeliverToChildren({
          delivery,
          parentWritable: this.cursor.parentWritable,
          serializedContext: this.cursor.serializedContext,
          sessionState: this.cursor.sessionState,
        });
        await this.cursor.adopt(routed);
        if (routed.kind === "cancel-turn") {
          this.abort({});
          return "cancel-turn";
        }
        delivery = routed.remainder;
      }
      if (delivery === undefined) return;
      this.bufferedDeliveries.push(delivery);
      this.admittedDeliveries.add(delivery);
      return;
    }
    if (command.kind === "clear" || command.kind === "compact") {
      this.bufferedSessionControls.push(command.kind);
      return;
    }
    if (command.kind === "session-timeout") {
      this.bufferedSessionControls.push("expired");
      return;
    }
    if (command.kind === "reset") {
      this.bufferedSessionControls.push("reset");
      this.abort({});
      return;
    }

    if (command.tasks === true) {
      await cancelAllIndexedSessionTasksStep({
        serializedContext: this.cursor.serializedContext,
        sessionState: this.cursor.sessionState,
      });
    }
    if (command.taskId !== undefined) this.discardTaskDeliveries(command.taskId);
    if (command.turnId !== undefined && command.turnId !== this.expectedTurnId) return;
    this.abort(
      command.turnId === undefined
        ? { tasks: command.tasks }
        : { tasks: command.tasks, turnId: command.turnId },
    );
  }

  private abort(payload: TurnCancelPayload): void {
    if (this.controller.signal.aborted) return;
    this.currentCancellation = payload;
    this.controller.abort(new TurnCancelledError());
  }

  private acceptTaskDelivery(delivery: DeliverHookPayload): boolean {
    const deliveryId = delivery.taskDeliveryId ?? delivery.caller?.taskId;
    if (deliveryId === undefined) return true;
    if (this.originatesFromCancelledTask(deliveryId) || this.seenTaskDeliveries.has(deliveryId)) {
      return false;
    }
    this.seenTaskDeliveries.add(deliveryId);
    return true;
  }

  private discardTaskDeliveries(taskId: string): void {
    this.cancelledTaskIds.add(taskId);
    const kept = this.bufferedDeliveries.filter((delivery) => {
      const deliveryId = delivery.taskDeliveryId ?? delivery.caller?.taskId;
      return deliveryId === undefined || !this.originatesFromCancelledTask(deliveryId);
    });
    this.bufferedDeliveries.splice(0, this.bufferedDeliveries.length, ...kept);
  }

  private originatesFromCancelledTask(deliveryId: string): boolean {
    return [...this.cancelledTaskIds].some(
      (taskId) => deliveryId === taskId || deliveryId.startsWith(`${taskId}:`),
    );
  }
}

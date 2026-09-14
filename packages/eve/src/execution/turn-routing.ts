import type { DeliverHookPayload } from "#channel/types.js";
import { routeSelectedDelivery } from "#execution/selected-delivery-router.js";
import type { SessionInputLedger } from "#execution/session-input-ledger.js";
import type { SessionInputQueue } from "#execution/session-input-queue.js";
import type { SessionInboxPayload, SessionInboxReader } from "#execution/session-inbox/inbox.js";
import { admitSessionInboxPayload, applySessionCancellation } from "#execution/session-routing.js";
import type { SessionStateCursor } from "#execution/session-state-cursor.js";
import type { RuntimeActionResultStepInput } from "#execution/turn-step.js";
import type { WorkflowToolRunMessage } from "#execution/tools/workflow/messages.js";
import { TurnCancelledError } from "#harness/turn-cancellation.js";
import { coalesceDeliveries } from "#harness/messages.js";

interface TurnRoutingInput {
  readonly callerCallId: string | undefined;
  readonly commandInbox: SessionInboxReader;
  readonly cursor: SessionStateCursor;
  readonly expectedTurnId: string;
  readonly ledger: SessionInputLedger;
  readonly queue: SessionInputQueue;
}

/** Owns admission policy, cancellation, and steering for one active turn. */
export class TurnRouting {
  private readonly admittedDeliveries = new Set<number>();
  private readonly runtimeResults: RuntimeActionResultStepInput[] = [];
  private readonly routedSteering: DeliverHookPayload[] = [];
  private readonly workflowMessages: WorkflowToolRunMessage[] = [];
  private readonly controller = new AbortController();
  private readonly input: TurnRoutingInput;

  constructor(input: TurnRoutingInput) {
    this.input = input;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  async takeSteering(): Promise<DeliverHookPayload | undefined> {
    await this.routeAdmittedSteering();
    if (this.routedSteering.length === 0) return undefined;
    const steering = this.routedSteering.splice(0);
    return steering.length === 1 ? steering[0] : coalesceDeliveries(steering);
  }

  private async routeAdmittedSteering(): Promise<void> {
    while (true) {
      const selection = this.input.queue.takeSteering(
        this.admittedDeliveries,
        this.input.callerCallId,
      );
      if (selection === undefined) return;
      for (const admission of selection.provenance.admissions) {
        this.admittedDeliveries.delete(admission.sequence);
      }
      const routed = await routeSelectedDelivery(selection, this.input.cursor);
      if (routed.kind === "cancel-turn") {
        this.abort();
        return;
      }
      if (routed.kind === "turn") this.routedSteering.push(routed.delivery);
    }
  }

  takeRuntimeResult(): RuntimeActionResultStepInput | undefined {
    return this.runtimeResults.shift();
  }

  takeWorkflowMessage(): WorkflowToolRunMessage | undefined {
    return this.workflowMessages.shift();
  }

  async waitFor<T>(operation: Promise<T>): Promise<T> {
    const settled = operation.then((value) => ({ kind: "operation" as const, value }));
    while (true) {
      const winner = await Promise.race([
        settled,
        this.input.commandInbox
          .read("interrupt")
          .then((lease) => ({ kind: "command" as const, lease })),
      ]);
      if (winner.kind === "operation") return winner.value;
      if (winner.lease === undefined) {
        throw new Error("Session command inbox closed before the active turn settled.");
      }
      winner.lease.consume();
      await this.admit(winner.lease.value);
    }
  }

  async admitBoundary(): Promise<void> {
    const pending = this.input.commandInbox.drain();
    for (const [index, payload] of pending.entries()) {
      if (this.signal.aborted) {
        this.input.commandInbox.restore(pending.slice(index));
        return;
      }
      await this.admit(payload);
    }
  }

  async admit(value: SessionInboxPayload): Promise<void> {
    const admitted = await admitSessionInboxPayload(value, this.input);
    switch (admitted.kind) {
      case "delivery":
        this.admittedDeliveries.add(admitted.admission.sequence);
        await this.routeAdmittedSteering();
        return;
      case "runtime-action-result":
        this.runtimeResults.push({
          kind: "runtime-action-result",
          results: admitted.payload.results,
        });
        return;
      case "workflow":
        this.workflowMessages.push(admitted.message);
        return;
      case "cancel":
        if (
          admitted.command.turnId !== undefined &&
          admitted.command.turnId !== this.input.expectedTurnId
        ) {
          return;
        }
        await applySessionCancellation(admitted.command, this.input);
        this.abort();
        return;
      case "authorization":
      case "consumed":
        return;
    }
  }

  private abort(): void {
    if (this.controller.signal.aborted) return;
    this.controller.abort(new TurnCancelledError());
  }
}

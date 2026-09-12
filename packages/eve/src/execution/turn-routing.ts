import type { DeliverHookPayload } from "#channel/types.js";
import type { SessionBacklog } from "#execution/session-backlog.js";
import type { SessionInbox, SessionInboxPayload } from "#execution/session-inbox/inbox.js";
import { routeSessionPayload, type TurnCancelRequest } from "#execution/session-routing.js";
import type { SessionStateCursor } from "#execution/session-state-cursor.js";
import type { RuntimeActionResultStepInput } from "#execution/turn-step.js";
import type { WorkflowToolRunMessage } from "#execution/tools/workflow/messages.js";
import { TurnCancelledError } from "#harness/turn-cancellation.js";

/**
 * Admission policy for one active turn. Routes arrivals against committed
 * state, decides which buffered deliveries may steer this turn, and owns the
 * turn's abort signal. It holds no transport queue of its own.
 */
interface TurnRoutingInput {
  readonly backlog: SessionBacklog;
  readonly callerCallId: string | undefined;
  readonly commandInbox: SessionInbox;
  readonly cursor: SessionStateCursor;
  readonly expectedTurnId: string;
}

export class TurnRouting {
  private readonly admittedDeliveries = new Set<DeliverHookPayload>();
  private readonly runtimeResults: RuntimeActionResultStepInput[] = [];
  private readonly workflowMessages: WorkflowToolRunMessage[] = [];
  private readonly controller = new AbortController();
  private readonly input: TurnRoutingInput;
  private currentCancellation: TurnCancelRequest | undefined;

  constructor(input: TurnRoutingInput) {
    this.input = input;
  }

  get cancellation(): TurnCancelRequest | undefined {
    return this.currentCancellation;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  takeSteering(): DeliverHookPayload | undefined {
    const steering = this.input.backlog.takeSteering(
      this.admittedDeliveries,
      this.input.callerCallId,
    );
    if (steering !== undefined) this.admittedDeliveries.clear();
    return steering;
  }

  takeRuntimeResult(): RuntimeActionResultStepInput | undefined {
    return this.runtimeResults.shift();
  }

  takeWorkflowMessage(): WorkflowToolRunMessage | undefined {
    return this.workflowMessages.shift();
  }

  /** Runs a step while servicing interrupts (cancel, reset, timeout) that must not wait for it. */
  async waitFor<T>(operation: Promise<T>): Promise<T> {
    const settled = operation.then((value) => ({ kind: "operation" as const, value }));
    while (true) {
      const winner = await Promise.race([
        settled,
        this.input.commandInbox
          .next("interrupt")
          .then((result) => ({ kind: "command" as const, result })),
      ]);
      if (winner.kind === "operation") return winner.value;
      if (winner.result.done) {
        throw new Error("Session command inbox closed before the active turn settled.");
      }
      this.input.commandInbox.consumeNext("interrupt");
      await this.handle(winner.result.value, false);
    }
  }

  /** Applies everything accepted up to this committed boundary. */
  async admitBoundary(): Promise<void> {
    const pending = this.input.commandInbox.drain();
    for (const [index, payload] of pending.entries()) {
      if (this.signal.aborted) {
        this.input.commandInbox.restore(pending.slice(index));
        return;
      }
      await this.handle(payload, true);
    }
  }

  async handle(value: SessionInboxPayload, routeDeliveries: boolean): Promise<void> {
    const routed = await routeSessionPayload(value, {
      backlog: this.input.backlog,
      cursor: this.input.cursor,
      routeDeliveries,
    });
    switch (routed.kind) {
      case "buffered":
        this.admittedDeliveries.add(routed.delivery);
        return;
      case "runtime-action-result":
        this.runtimeResults.push({
          kind: "runtime-action-result",
          results: routed.payload.results,
        });
        return;
      case "workflow":
        this.workflowMessages.push(routed.message);
        return;
      case "cancel":
        if (
          routed.request.turnId !== undefined &&
          routed.request.turnId !== this.input.expectedTurnId
        )
          return;
        this.abort(routed.request);
        return;
      case "authorization":
      case "consumed":
        return;
    }
  }

  private abort(request: TurnCancelRequest): void {
    if (this.controller.signal.aborted) return;
    this.currentCancellation = request;
    this.controller.abort(new TurnCancelledError());
  }
}

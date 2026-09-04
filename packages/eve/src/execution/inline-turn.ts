import type { DeliverHookPayload, HookPayload, SessionCapabilities } from "#channel/types.js";
import { readAcceptedDeploymentId } from "#execution/accepted-delivery-deployment.js";
import { cancelAllIndexedSessionTasksStep } from "#execution/cancel-indexed-session-tasks-step.js";
import type {
  InitialTurnStep,
  TurnStepPayload,
} from "#execution/durable-session-migrations/turn-workflow.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { DurableStepResult, NextDriverAction } from "#execution/next-driver-action.js";
import { reportDroppedWirePayloadStep } from "#execution/report-dropped-wire-payload-step.js";
import type { SessionCommandInbox, SessionInboxPayload } from "#execution/session-command-inbox.js";
import { SessionStateCursor } from "#execution/session-state-cursor.js";
import type { TurnCancelPayload } from "#execution/turn-cancellation-token.js";
import {
  sessionInboxWire,
  SessionInboxWireError,
  type DecodedSessionInbox,
} from "#execution/wire/session-inbox-wire.js";
import { turnStep } from "#execution/workflow-steps.js";
import { activeTurnId } from "#harness/active-turn-id.js";
import { TurnCancelledError } from "#harness/turn-cancellation.js";
import type { RunMode } from "#shared/run-mode.js";

export type InlineTurnOutcome =
  | {
      readonly initialCancellation?: TurnCancelPayload;
      readonly initialStep?: InitialTurnStep;
      readonly kind: "child" | "continue";
    }
  | { readonly action: NextDriverAction; readonly kind: "result" };

/** Runs same-deployment steps directly until they need the shared turn runner. */
export async function runInlineTurn(input: {
  readonly bufferedDeliveries: DeliverHookPayload[];
  readonly bufferedSessionControls: Array<"clear" | "compact" | "expired" | "reset">;
  readonly cancelledTaskIds?: Set<string>;
  readonly capabilities?: SessionCapabilities;
  readonly commandInbox: SessionCommandInbox;
  readonly delivery: HookPayload;
  readonly mode: RunMode;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly seenTaskDeliveries?: Set<string>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly stateCursor?: SessionStateCursor;
}): Promise<InlineTurnOutcome> {
  const acceptedDeploymentId = readAcceptedDeploymentId(input.delivery);
  if (acceptedDeploymentId === undefined) return { kind: "child" };

  const cursor =
    input.stateCursor ??
    new SessionStateCursor({
      serializedContext: input.serializedContext,
      sessionState: input.sessionState,
    });
  const control = new InlineTurnControl({
    bufferedDeliveries: input.bufferedDeliveries,
    bufferedSessionControls: input.bufferedSessionControls,
    cancelledTaskIds: input.cancelledTaskIds,
    commandInbox: input.commandInbox,
    expectedTurnId: activeTurnId(input.sessionState.emissionState),
    seenTaskDeliveries: input.seenTaskDeliveries,
    stateCursor: cursor,
  });
  let nextStepInput: TurnStepPayload | undefined = input.delivery;

  while (true) {
    const beforeStep = {
      serializedContext: cursor.serializedContext,
      sessionState: cursor.sessionState,
    };
    const result = await control.waitForStep(
      turnStep({
        abortSignal: control.signal,
        acceptedDeploymentId,
        input: nextStepInput,
        parentWritable: input.parentWritable,
        serializedContext: cursor.serializedContext,
        sessionState: cursor.sessionState,
      }),
    );

    if (result.requiresChildDispatch === true) {
      return { initialCancellation: control.initialCancellation, kind: "child" };
    }

    const initialStep = { beforeStep, result } satisfies InitialTurnStep;
    if (
      control.initialCancellation !== undefined ||
      result.action === "cancelled" ||
      (result.backgroundTasks?.length ?? 0) > 0
    ) {
      return continueOutcome(control, initialStep);
    }

    if (result.action === "done") {
      return {
        action: {
          isError: result.isError,
          kind: "done",
          output: result.output ?? "",
          serializedContext: result.serializedContext,
          sessionState: result.sessionState,
          usage: result.usage,
          usageDelta: result.usageDelta,
        },
        kind: "result",
      };
    }

    if (result.action === "park" && result.pendingCoordinationCallIds !== undefined) {
      return continueOutcome(control, initialStep);
    }

    if (result.action === "park") {
      const canPark =
        result.hasPendingAuthorization ||
        (result.hasPendingInputBatch && input.capabilities?.requestInput === true) ||
        input.mode === "conversation";
      if (!canPark) return continueOutcome(control, initialStep);
      return {
        action: {
          authorizationAttemptIds: result.authorizationAttemptIds,
          authorizationNames: result.authorizationNames,
          kind: "park",
          serializedContext: result.serializedContext,
          sessionState: result.sessionState,
          settled: result.settled,
        },
        kind: "result",
      };
    }

    const previousContinuationToken = cursor.sessionState.continuationToken;
    cursor.adoptState(result);
    if (
      cursor.sessionState.continuationToken !== "" &&
      cursor.sessionState.continuationToken !== previousContinuationToken
    ) {
      await input.commandInbox.rekeyContinuation(cursor.sessionState.continuationToken);
    }
    nextStepInput = undefined;
  }
}

function continueOutcome(
  control: InlineTurnControl,
  initialStep: InitialTurnStep,
): Exclude<InlineTurnOutcome, { readonly kind: "result" }> {
  return {
    initialCancellation: control.initialCancellation,
    initialStep,
    kind: "continue",
  };
}

class InlineTurnControl {
  private readonly bufferedDeliveries: DeliverHookPayload[];
  private readonly bufferedSessionControls: Array<"clear" | "compact" | "expired" | "reset">;
  private readonly cancelledTaskIds: Set<string>;
  private readonly commandInbox: SessionCommandInbox;
  private readonly controller = new AbortController();
  private readonly expectedTurnId: string;
  private readonly seenTaskDeliveries: Set<string>;
  private readonly stateCursor: SessionStateCursor;
  private cancellation: TurnCancelPayload | undefined;

  constructor(input: {
    readonly bufferedDeliveries: DeliverHookPayload[];
    readonly bufferedSessionControls: Array<"clear" | "compact" | "expired" | "reset">;
    readonly cancelledTaskIds?: Set<string>;
    readonly commandInbox: SessionCommandInbox;
    readonly expectedTurnId: string;
    readonly seenTaskDeliveries?: Set<string>;
    readonly stateCursor: SessionStateCursor;
  }) {
    this.bufferedDeliveries = input.bufferedDeliveries;
    this.bufferedSessionControls = input.bufferedSessionControls;
    this.cancelledTaskIds = input.cancelledTaskIds ?? new Set();
    this.commandInbox = input.commandInbox;
    this.expectedTurnId = input.expectedTurnId;
    this.seenTaskDeliveries = input.seenTaskDeliveries ?? new Set();
    this.stateCursor = input.stateCursor;
  }

  get initialCancellation(): TurnCancelPayload | undefined {
    return this.cancellation;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  async waitForStep(step: Promise<DurableStepResult>): Promise<DurableStepResult> {
    const settled = step.then((result) => ({ kind: "step" as const, result }));
    while (true) {
      const winner = await Promise.race([
        settled,
        this.commandInbox.next().then((result) => ({ kind: "command" as const, result })),
      ]);
      if (winner.kind === "step") return winner.result;
      if (winner.result.done) {
        throw new Error("Session command inbox closed before the inline turn step settled.");
      }
      this.commandInbox.consumeNext();
      await this.handle(winner.result.value);
    }
  }

  private abort(payload: TurnCancelPayload): void {
    if (this.controller.signal.aborted) return;
    this.cancellation = payload;
    this.controller.abort(new TurnCancelledError());
  }

  private acceptTaskDelivery(command: DeliverHookPayload): boolean {
    const deliveryId = command.taskDeliveryId ?? command.caller?.taskId;
    if (deliveryId === undefined) return true;
    if (this.originatesFromCancelledTask(deliveryId)) return false;
    if (this.seenTaskDeliveries.has(deliveryId)) return false;
    this.seenTaskDeliveries.add(deliveryId);
    return true;
  }

  private async handle(value: SessionInboxPayload): Promise<void> {
    if (value.kind === "runtime-action-result") return;
    let command: DecodedSessionInbox;
    try {
      command = sessionInboxWire.decode(value);
    } catch (error) {
      if (!(error instanceof SessionInboxWireError)) throw error;
      await reportDroppedWirePayloadStep({ detail: error.message, family: "session-inbox" });
      return;
    }

    if (command.kind === "deliver") {
      if (!this.acceptTaskDelivery(command)) return;
      this.bufferedDeliveries.push(command);
      if (command.turnPolicy === "steer" && deliveryHasMessage(command)) this.abort({});
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
    if (command.kind === "cancel") {
      if ("tasks" in command && command.tasks === true) {
        await cancelAllIndexedSessionTasksStep({
          serializedContext: this.stateCursor.serializedContext,
          sessionState: this.stateCursor.sessionState,
        });
      }
      if (command.taskId !== undefined) this.discardTaskDeliveries(command.taskId);
      const turnId =
        command.taskId !== undefined &&
        command.turnId !== undefined &&
        command.turnId !== this.expectedTurnId
          ? undefined
          : command.turnId;
      if (turnId === undefined || turnId === this.expectedTurnId) {
        const payload =
          turnId === undefined ? { tasks: command.tasks } : { tasks: command.tasks, turnId };
        this.abort(payload);
      }
    }
  }

  private discardTaskDeliveries(taskId: string): void {
    this.cancelledTaskIds.add(taskId);
    const kept = this.bufferedDeliveries.filter((delivery) => !this.shouldDiscard(delivery));
    this.bufferedDeliveries.splice(0, this.bufferedDeliveries.length, ...kept);
  }

  private originatesFromCancelledTask(deliveryId: string): boolean {
    return [...this.cancelledTaskIds].some(
      (taskId) => deliveryId === taskId || deliveryId.startsWith(`${taskId}:`),
    );
  }

  private shouldDiscard(delivery: DeliverHookPayload): boolean {
    const deliveryId = delivery.taskDeliveryId ?? delivery.caller?.taskId;
    return deliveryId !== undefined && this.originatesFromCancelledTask(deliveryId);
  }
}

function deliveryHasMessage(delivery: DeliverHookPayload): boolean {
  return delivery.payloads.some((payload) => payload.message !== undefined);
}

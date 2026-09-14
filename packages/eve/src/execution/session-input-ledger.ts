import type { DeliverHookPayload } from "#channel/types.js";
import type { SessionStateCursor } from "#execution/session-state-cursor.js";

const SESSION_INPUT_LEDGER_KEY = "eve.sessionInputLedger.v1";

interface SessionInputLedgerState {
  readonly cancelledTaskIds: readonly string[];
  readonly seenTaskDeliveryIds: readonly string[];
}

/** Durable idempotency and cancellation facts for admitted task deliveries. */
export class SessionInputLedger {
  private readonly cursor: SessionStateCursor;

  constructor(cursor: SessionStateCursor) {
    this.cursor = cursor;
  }

  async admit(delivery: DeliverHookPayload): Promise<boolean> {
    const deliveryId = taskDeliveryId(delivery);
    if (deliveryId === undefined) return true;
    const state = this.read();
    if (
      state.seenTaskDeliveryIds.includes(deliveryId) ||
      state.cancelledTaskIds.some(
        (taskId) => deliveryId === taskId || deliveryId.startsWith(`${taskId}:`),
      )
    ) {
      return false;
    }
    await this.write({
      ...state,
      seenTaskDeliveryIds: [...state.seenTaskDeliveryIds, deliveryId],
    });
    return true;
  }

  async rememberTask(taskId: string): Promise<void> {
    const state = this.read();
    if (state.seenTaskDeliveryIds.includes(taskId)) return;
    await this.write({
      ...state,
      seenTaskDeliveryIds: [...state.seenTaskDeliveryIds, taskId],
    });
  }

  async cancelTask(taskId: string): Promise<void> {
    const state = this.read();
    if (state.cancelledTaskIds.includes(taskId)) return;
    await this.write({
      ...state,
      cancelledTaskIds: [...state.cancelledTaskIds, taskId],
    });
  }

  isTaskCancelled(taskId: string): boolean {
    return this.read().cancelledTaskIds.includes(taskId);
  }

  private read(): SessionInputLedgerState {
    const value = this.cursor.sessionState.snapshot.session.state?.[SESSION_INPUT_LEDGER_KEY];
    if (typeof value !== "object" || value === null) {
      return { cancelledTaskIds: [], seenTaskDeliveryIds: [] };
    }
    const candidate = value as Partial<SessionInputLedgerState>;
    return {
      cancelledTaskIds: strings(candidate.cancelledTaskIds),
      seenTaskDeliveryIds: strings(candidate.seenTaskDeliveryIds),
    };
  }

  private async write(ledger: SessionInputLedgerState): Promise<void> {
    const durable = this.cursor.sessionState;
    const session = durable.snapshot.session;
    await this.cursor.apply({
      sessionState: {
        ...durable,
        snapshot: {
          session: {
            ...session,
            state: { ...session.state, [SESSION_INPUT_LEDGER_KEY]: ledger },
          },
        },
      },
    });
  }
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function taskDeliveryId(delivery: DeliverHookPayload): string | undefined {
  return delivery.taskDeliveryId ?? delivery.caller?.taskId;
}

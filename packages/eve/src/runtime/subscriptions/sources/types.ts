import type { AlsContext } from "#context/container.js";
import type {
  OpenOutcome,
  OpenedSubscription,
  SubscriptionBinding,
  SubscriptionEvent,
} from "#runtime/subscriptions/state.js";

export interface SubscriptionSourceRuntime {
  open(input: {
    readonly ctx: AlsContext;
    readonly binding: SubscriptionBinding;
    readonly idempotencyKey: string;
  }): Promise<OpenOutcome>;
  close(input: {
    readonly ctx: AlsContext;
    readonly binding: SubscriptionBinding;
    readonly opened: OpenedSubscription;
  }): Promise<"pending" | "done">;
  deliver(input: {
    readonly ctx: AlsContext;
    readonly binding: SubscriptionBinding;
    readonly event: SubscriptionEvent;
  }): Promise<void>;
}

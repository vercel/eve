import type { AlsContext } from "#context/container.js";
import type {
  OpenOutcome,
  OpenedSubscription,
  SubscriptionBinding,
  SubscriptionEvent,
} from "#runtime/subscriptions/state.js";

/** What each kind of source does for a subscription; everything else is shared by every source. */
export interface SubscriptionSourceRuntime {
  /** Opens the subscription upstream, if the source has an upstream, and names the key its events carry. */
  open(input: {
    readonly ctx: AlsContext;
    readonly binding: SubscriptionBinding;
    readonly idempotencyKey: string;
  }): Promise<OpenOutcome>;
  /** Closes what `open` opened. `pending` asks to be called again later. */
  close(input: {
    readonly ctx: AlsContext;
    readonly binding: SubscriptionBinding;
    readonly opened: OpenedSubscription;
  }): Promise<"pending" | "done">;
  /** Hands one occurrence to the subscribing session, as that session. */
  deliver(input: {
    readonly ctx: AlsContext;
    readonly binding: SubscriptionBinding;
    readonly event: SubscriptionEvent;
  }): Promise<void>;
}

import type { RelayedInteractionEvent } from "#channel/types.js";
import { defined } from "#harness/facts.js";

type RelayedOf<T extends RelayedInteractionEvent["type"]> = Extract<
  RelayedInteractionEvent,
  { readonly type: T }
>;

export function relayEvent<T extends RelayedInteractionEvent["type"]>(
  type: T,
  data: RelayedOf<T>["data"],
): RelayedOf<T> {
  return { data: defined(data as object), type } as RelayedOf<T>;
}

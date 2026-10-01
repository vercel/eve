import type { JsonObject } from "#shared/json.js";

/** The `clientContext` a client sends with a message or input response, as sent. */
export type ClientContextValue = string | readonly string[] | JsonObject;

const clientContextValueKey = "__eveClientContextValue";

const clientContextKey = "__eveClientContext";

type ClientContextCarrier = {
  [clientContextKey]?: readonly string[];
  [clientContextValueKey]?: ClientContextValue;
};

export function attachClientContext<T extends object>(
  target: T,
  context: readonly string[] | undefined,
  value?: ClientContextValue,
): T {
  if (context !== undefined) {
    (target as T & ClientContextCarrier)[clientContextKey] = context;
  }
  if (value !== undefined) {
    (target as T & ClientContextCarrier)[clientContextValueKey] = value;
  }
  return target;
}

export function readClientContext(target: object | undefined): readonly string[] | undefined {
  return (target as ClientContextCarrier | undefined)?.[clientContextKey];
}

export function readClientContextValue(target: object | undefined): ClientContextValue | undefined {
  return (target as ClientContextCarrier | undefined)?.[clientContextValueKey];
}

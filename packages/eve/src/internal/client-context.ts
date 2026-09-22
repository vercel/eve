const clientContextKey = "__eveClientContext";

type ClientContextCarrier = {
  [clientContextKey]?: readonly string[];
};

export function attachClientContext<T extends object>(
  target: T,
  context: readonly string[] | undefined,
): T {
  if (context !== undefined) {
    (target as T & ClientContextCarrier)[clientContextKey] = context;
  }
  return target;
}

export function readClientContext(target: object | undefined): readonly string[] | undefined {
  return (target as ClientContextCarrier | undefined)?.[clientContextKey];
}

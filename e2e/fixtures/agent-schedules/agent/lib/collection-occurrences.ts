const admitted = new Map<string, string>();

export function recordCollectionOccurrence(name: string, sessionId: string): void {
  if (admitted.size >= 100) admitted.delete(admitted.keys().next().value!);
  admitted.set(name, sessionId);
}

export function takeCollectionOccurrence(name: string): string | undefined {
  const sessionId = admitted.get(name);
  admitted.delete(name);
  return sessionId;
}

const deliveries = new Map<string, string>();

export function recordCollectionDelivery(name: string, content: string): void {
  if (deliveries.size >= 100) deliveries.delete(deliveries.keys().next().value!);
  deliveries.set(name, content);
}

export function takeCollectionDelivery(name: string): string | undefined {
  const content = deliveries.get(name);
  deliveries.delete(name);
  return content;
}

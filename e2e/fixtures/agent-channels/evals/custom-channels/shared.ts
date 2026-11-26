import type { EveEvalTargetHandle } from "eve/evals";

export async function postChannel<T>(
  target: EveEvalTargetHandle,
  path: string,
  body: unknown,
): Promise<T> {
  const response = await target.fetch(path, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`POST ${path} failed (${response.status}): ${text}`);
  }
  return JSON.parse(text) as T;
}

export function consumedDeliveries(stream: string, eventId: string): number {
  return stream
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => (JSON.parse(line) as { facts?: { type: string }[] }).facts ?? [])
    .filter((fact) => fact.type === "delivery.consumed" && JSON.stringify(fact).includes(eventId))
    .length;
}

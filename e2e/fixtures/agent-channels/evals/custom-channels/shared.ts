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

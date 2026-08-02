const SESSION_CALLBACK_TIMEOUT_MS = 30_000;

/** Posts one framework callback payload with the shared callback transport policy. */
export async function postSessionCallbackRequest(input: {
  readonly body: unknown;
  readonly url: string;
}): Promise<Response> {
  return await fetch(input.url, {
    body: JSON.stringify(input.body),
    headers: {
      "content-type": "application/json",
    },
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(SESSION_CALLBACK_TIMEOUT_MS),
  });
}

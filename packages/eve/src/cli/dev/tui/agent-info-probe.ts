import {
  AgentInfoResponseError,
  ClientError,
  type AgentInfoResult,
  type Client,
} from "#client/index.js";

const defaultRetryDelaysMs = [100] as const;

export type AgentInfoProbeResult =
  | { readonly kind: "ready"; readonly info: AgentInfoResult }
  | { readonly kind: "unavailable"; readonly error: unknown };

function isRetryableAgentInfoFailure(error: unknown): boolean {
  if (error instanceof AgentInfoResponseError) return false;
  if (error instanceof ClientError) return error.status >= 500;
  return error instanceof TypeError;
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * Reads best-effort inspection data from a server whose lifecycle belongs to
 * another process. Transient transport and server failures can occur while
 * that process reloads, but auth and schema failures cannot be fixed by retry.
 */
export async function probeAgentInfo(input: {
  readonly client: Pick<Client, "info">;
  readonly retryDelaysMs?: readonly number[];
  readonly wait?: (delayMs: number) => Promise<void>;
}): Promise<AgentInfoProbeResult> {
  const retryDelaysMs = input.retryDelaysMs ?? defaultRetryDelaysMs;
  const wait = input.wait ?? sleep;

  for (let attempt = 0; ; attempt += 1) {
    try {
      return { kind: "ready", info: await input.client.info() };
    } catch (error) {
      const delayMs = retryDelaysMs[attempt];
      if (!isRetryableAgentInfoFailure(error) || delayMs === undefined) {
        return { kind: "unavailable", error };
      }
      await wait(delayMs);
    }
  }
}

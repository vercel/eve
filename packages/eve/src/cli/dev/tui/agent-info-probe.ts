import {
  AgentInfoResponseError,
  ClientError,
  type AgentInfoResult,
  type Client,
} from "#client/index.js";

const RETRY_DELAY_MS = 100;

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
}): Promise<AgentInfoProbeResult> {
  try {
    return { kind: "ready", info: await input.client.info() };
  } catch (error) {
    if (!isRetryableAgentInfoFailure(error)) return { kind: "unavailable", error };
  }

  await sleep(RETRY_DELAY_MS);

  try {
    return { kind: "ready", info: await input.client.info() };
  } catch (error) {
    return { kind: "unavailable", error };
  }
}

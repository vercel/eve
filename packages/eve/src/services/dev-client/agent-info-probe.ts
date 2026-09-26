import {
  AgentInfoResponseError,
  ClientError,
  type AgentInfoResult,
  type Client,
} from "#client/index.js";

const RETRY_DELAY_MS = 100;

type AgentInfoProbeResult =
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
  readonly timeoutMs?: number;
}): Promise<AgentInfoProbeResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<AgentInfoProbeResult>((resolve) => {
    timer = setTimeout(() => {
      const error = new Error("Agent inspection timed out.");
      controller.abort(error);
      resolve({ kind: "unavailable", error });
    }, input.timeoutMs ?? 5000);
  });
  try {
    // The deadline also bounds user-provided credential callbacks, which may ignore abort.
    return await Promise.race([readAgentInfo(input.client, controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function readAgentInfo(
  client: Pick<Client, "info">,
  signal: AbortSignal,
): Promise<AgentInfoProbeResult> {
  try {
    return { kind: "ready", info: await client.info({ signal }) };
  } catch (error) {
    if (signal.aborted || !isRetryableAgentInfoFailure(error))
      return { kind: "unavailable", error };
  }

  await sleep(RETRY_DELAY_MS);

  try {
    signal.throwIfAborted();
    return { kind: "ready", info: await client.info({ signal }) };
  } catch (error) {
    return { kind: "unavailable", error };
  }
}

import { Client } from "#client/index.js";
import { resolveVerifiedRemoteDevelopmentClient } from "#setup/verified-remote-client.js";
import { toErrorMessage } from "#shared/errors.js";

/** Sends one remote turn without starting the terminal UI. */
export async function runRemotePrint(input: {
  readonly headers?: Readonly<Record<string, string>>;
  readonly prompt: string;
  readonly serverUrl: string;
  readonly signal: AbortSignal;
  readonly workspaceRoot: string;
}): Promise<string> {
  const { options } = await resolveVerifiedRemoteDevelopmentClient({
    headers: input.headers,
    serverUrl: input.serverUrl,
    signal: input.signal,
    workspaceRoot: input.workspaceRoot,
  });
  const { delivery } = await new Client(options).sessions.create({
    message: input.prompt,
    signal: input.signal,
  });
  let result: Awaited<ReturnType<typeof delivery.result>>;
  try {
    result = await delivery.result({ signal: input.signal });
  } catch (error) {
    if (input.signal.aborted) {
      throw new Error(
        `Interrupted while reading session ${delivery.sessionId}; it may still be running.`,
      );
    }
    throw new Error(`Session ${delivery.sessionId}: ${toErrorMessage(error)}`);
  }
  if (input.signal.aborted) {
    throw new Error(
      `Interrupted while reading session ${delivery.sessionId}; it may still be running.`,
    );
  }
  if (result.status === "failed") {
    throw new Error(`Session ${delivery.sessionId} failed: ${result.error.message}`);
  }
  if (result.status === "cancelled") {
    throw new Error(`Turn in session ${delivery.sessionId} was cancelled.`);
  }
  if (result.status === "awaiting-input") {
    const signIns =
      result.interactions.length > 0 &&
      result.interactions.every((interaction) => interaction.request.kind === "sign-in");
    throw new Error(
      signIns
        ? `Session ${delivery.sessionId} is waiting for authorization; use the client API to follow it, or start a new conversation with eve remote connect.`
        : `Session ${delivery.sessionId} is waiting for input; use the client API to answer it, or start a new conversation with eve remote connect.`,
    );
  }
  return result.reply ?? "";
}

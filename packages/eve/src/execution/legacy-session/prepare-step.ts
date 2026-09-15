import { hydrateWorkflowArguments } from "#compiled/@workflow/core/serialization.js";
import { getWorld, resolveRunEncryptionKey } from "#internal/workflow/runtime.js";
import { DEFAULT_SESSION_TIMEOUT_MS } from "#execution/session/timeout.js";
import { readLegacyTurnInput, type LegacyTurnInput } from "./input.js";
import { readLegacySnapshot, importConversation } from "./snapshot.js";
import { SESSION_INBOX_CONTEXT_KEY } from "#execution/session-inbox/address.js";
import { isObject } from "#shared/guards.js";

/** Persist the import before publishing its current-generation inbox. */
export async function prepareLegacySessionStep(rawInput: unknown) {
  "use step";
  const input = readLegacyTurnInput(rawInput);
  const originalSession = readLegacySnapshot(input.sessionState);
  const sessionState = importConversation(originalSession);
  const world = await getWorld();
  const run = await world.runs.get(sessionState.sessionId);
  const args: unknown = await hydrateWorkflowArguments(
    run.input,
    run.runId,
    await resolveRunEncryptionKey(world, run),
  );
  const driverInput = Array.isArray(args) && isObject(args[0]) ? args[0] : undefined;
  if (driverInput === undefined) throw new Error("Cannot read the original session timeout.");
  const timeout = driverInput.sessionTimeoutMs;
  if (
    timeout !== undefined &&
    timeout !== false &&
    (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout < 0)
  )
    throw new Error("Invalid original session timeout.");
  const sessionTimeoutMs = timeout ?? DEFAULT_SESSION_TIMEOUT_MS;
  const serializedContext: Record<string, unknown> = {
    ...input.serializedContext,
    "eve.sessionId": sessionState.sessionId,
    [SESSION_INBOX_CONTEXT_KEY]: { sessionId: sessionState.sessionId },
  };
  delete serializedContext["eve.sessionCallback"];
  const channel = serializedContext["eve.channel"];
  if (isObject(channel) && channel.kind === "subagent" && isObject(channel.state)) {
    serializedContext["eve.channel"] = {
      ...channel,
      state: { ...channel.state, parentContinuationToken: "" },
    };
  }
  return {
    input: {
      ...input,
      retention: input.retention ?? (driverInput.retention as LegacyTurnInput["retention"]),
    },
    originalSession,
    sessionState,
    serializedContext,
    sessionTimeoutMs: sessionTimeoutMs as number | false,
    deploymentId: process.env.VERCEL_DEPLOYMENT_ID?.trim() || (await world.getDeploymentId()),
  };
}
export type PreparedLegacySession = Awaited<ReturnType<typeof prepareLegacySessionStep>>;
export type { LegacyTurnInput };

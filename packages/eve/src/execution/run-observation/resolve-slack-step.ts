import { deserializeContext } from "#context/serialize.js";
import { getSlackObservation } from "#public/channels/slack/observation/ownership.js";
import type { SlackObservationDestination } from "#public/channels/slack/observation/apply-step.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";

export async function resolveSlackObservationStep(input: {
  readonly serializedContext: Record<string, unknown>;
}): Promise<{
  readonly destination: SlackObservationDestination;
}> {
  "use step";
  const ctx = await deserializeContext(input.serializedContext);
  const adapter = ctx.require(ChannelKey);
  if (getSlackObservation(adapter) === undefined)
    throw new Error("Slack run observation is not configured.");
  const state = adapter.state;
  const channelId = state?.["channelId"];
  const threadTs = state?.["threadTs"];
  if (typeof channelId !== "string" || !channelId || typeof threadTs !== "string" || !threadTs) {
    throw new Error("Slack run observation requires an existing thread and channel.");
  }
  const installationTeamId = state?.["installationTeamId"];
  const destination: { channelId: string; threadTs: string; installationTeamId?: string } = {
    channelId,
    threadTs,
  };
  if (typeof installationTeamId === "string") destination.installationTeamId = installationTeamId;
  return { destination };
}

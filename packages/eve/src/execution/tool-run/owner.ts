import { disposeHook } from "#execution/hook-ownership.js";
import {
  deriveRunOwner,
  outcomeHook,
  reportHook,
  requestHook,
  type RunOutcomeMessage,
  type RunReport,
  type RunRequestMessage,
} from "#execution/tool-run/messages.js";
import { type ChannelReader, createChannelReader } from "#execution/tool-run/owner-channels.js";

/** An owner's run channels in read priority: what a run said before its outcome lands first. */
export type RunOwnerReaders = readonly [
  ChannelReader<"report", RunReport>,
  ChannelReader<"request", RunRequestMessage>,
  ChannelReader<"outcome", RunOutcomeMessage>,
];

export interface RunOwnerChannels {
  readonly readers: RunOwnerReaders;
  dispose(): Promise<void>;
}

/**
 * Opens the three hooks a turn or task listens to its runs on. Every run the
 * owner starts addresses them through `deriveRunOwner(inboxToken)`, so the
 * owner creates them from the same token before it starts anything.
 */
export function openRunOwnerChannels(inboxToken: string): RunOwnerChannels {
  const owner = deriveRunOwner(inboxToken);
  const report = reportHook.create({ token: owner.report });
  const request = requestHook.create({ token: owner.request });
  const outcome = outcomeHook.create({ token: owner.outcome });
  return {
    readers: [
      createChannelReader("report", report),
      createChannelReader("request", request),
      createChannelReader("outcome", outcome),
    ],
    async dispose() {
      await disposeHook(report);
      await disposeHook(request);
      await disposeHook(outcome);
    },
  };
}

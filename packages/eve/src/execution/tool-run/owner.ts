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

/** In read priority: what a run said before its outcome lands first. */
export type RunOwnerReaders = readonly [
  ChannelReader<"report", RunReport>,
  ChannelReader<"request", RunRequestMessage>,
  ChannelReader<"outcome", RunOutcomeMessage>,
];

export interface RunOwnerChannels {
  readonly readers: RunOwnerReaders;
  dispose(): Promise<void>;
}

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
      await Promise.all([disposeHook(report), disposeHook(request), disposeHook(outcome)]);
    },
  };
}

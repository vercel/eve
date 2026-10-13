import { isChannel } from "eve/channels";
import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import metadataProvider from "../channels/metadata-provider";

/**
 * Smoke-test fixture: resolves a tool only when the session was started
 * via the `metadata-provider` channel. Verifies that
 * `RecordContext.channel.metadata` surfaces the channel's
 * `metadata(state)` projection and that `isChannel` narrows it.
 */
export default defineDynamic({
  select: (view, { channel }) => {
    if (!isChannel(channel, metadataProvider)) return null;
    const { topic, contextMessages } = channel.metadata;
    return topic
      ? {
          channelKind: channel.kind ?? null,
          contextMessages: contextMessages ?? null,
          topic,
          turn: view.latest["turn.started"] ?? null,
        }
      : null;
  },
  render: (selected) => {
    if (selected === null) return null;
    const { channelKind, contextMessages, topic } = selected;

    return defineTool({
      description:
        "Returns channel metadata visible to this resolver. " +
        "Only call when the user asks to read channel context.",
      inputSchema: z.object({}),
      async execute() {
        return {
          channelKind,
          topic,
          contextMessages,
        };
      },
    });
  },
});

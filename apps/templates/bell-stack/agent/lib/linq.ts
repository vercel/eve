import type { LinqChannelConfig } from "eve/channels/linq";
import { browserChannelEvents } from "./browser-runtime";

export const linqBrowserEvents: NonNullable<LinqChannelConfig["events"]> = {
  ...browserChannelEvents,
  async "session.ended"(event, ctx) {
    try {
      await browserChannelEvents["session.ended"](event, ctx);
    } finally {
      if (event.data.outcome === "failed") {
        await ctx.channel.thread?.post(
          "This session could not recover from an error. Start a new conversation to continue.",
        );
      }
    }
  },
};

export function requiredEnvironmentValue(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the Linq channel.`);
  return value;
}

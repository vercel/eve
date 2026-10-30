// Sample conversations shown under a channel page's intro, one use case per
// channel, drawn from the Use Cases page: business agents on Slack and GitHub,
// customer-facing agents (AaaS) on iMessage. They are decorative and live
// here, not in MDX, so the Markdown that agents read and the docs packaged
// with `eve` stay free of them.

export interface PreviewMessage {
  from: "agent" | "user";
  /**
   * Plain text. On Slack and GitHub, `code`, [label](url), and @mentions
   * render in that app's styles, and GitHub also styles #123 references.
   */
  text: string;
  /** Slack only: a table under the text. The first row is the header. */
  table?: string[][];
}

export type ChannelScene =
  | { surface: "slack"; agent: string; channel: string; messages: PreviewMessage[] }
  | {
      surface: "github";
      agent: string;
      thread: { kind: "issue" | "pull"; number: number; title: string };
      messages: PreviewMessage[];
    }
  | { surface: "imessage"; agent: string; messages: PreviewMessage[] };

export interface ChannelPreview {
  /** What the scene shows, for screen readers. */
  alt: string;
  scene: ChannelScene;
}

/** Keyed by docs page slug, such as `channels/slack`. */
export const channelPreviews: Record<string, ChannelPreview> = {
  "channels/slack": {
    alt: "A Slack thread where someone asks a company brain agent for October's order count, and it replies with a table comparing September and October.",
    scene: {
      surface: "slack",
      agent: "brain",
      channel: "ask-data",
      messages: [
        { from: "user", text: "@brain how many orders did we have in October?" },
        {
          from: "agent",
          text: "1,284 orders in October, up 9% from September.",
          table: [
            ["Month", "Orders", "Revenue"],
            ["Sep", "1,178", "$56.6K"],
            ["Oct", "1,284", "$61.7K"],
          ],
        },
      ],
    },
  },
  "channels/github": {
    alt: "A GitHub issue about a checkout crash where someone asks a software factory agent to take it, and it replies that it opened a draft pull request with a fix and a regression test.",
    scene: {
      surface: "github",
      agent: "factory",
      thread: { kind: "issue", number: 471, title: "Checkout returns 500 on empty carts" },
      messages: [
        { from: "user", text: "@factory can you take this one?" },
        {
          from: "agent",
          text: "On it. Opened draft PR #483 with a guard in `pricing.ts` and a regression test.",
        },
      ],
    },
  },
  "channels/photon": {
    alt: "An iMessage conversation where a customer asks a store's support agent about a late order, and it replies with the delivery status.",
    scene: {
      surface: "imessage",
      agent: "Acme Support",
      messages: [
        { from: "user", text: "Where's my order? It was supposed to come today" },
        {
          from: "agent",
          text: "Order #4821 is out for delivery and should arrive by 6 PM. Want a text when it's dropped off?",
        },
        { from: "user", text: "yes please" },
      ],
    },
  },
  "channels/linq": {
    alt: "An iMessage conversation where a patient asks a dental office's agent to move an appointment, and it offers two open times.",
    scene: {
      surface: "imessage",
      agent: "Northside Dental",
      messages: [
        { from: "user", text: "Can I move my cleaning to next week?" },
        { from: "agent", text: "Sure. Tuesday at 10:30 or Thursday at 2:00?" },
        { from: "user", text: "Thursday works" },
      ],
    },
  },
};

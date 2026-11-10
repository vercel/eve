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

interface SceneAgent {
  agent: string;
  /**
   * Square avatar image for the agent, relative to `public/`. It is cropped to
   * a circle or rounded square, so leave padding around the mark.
   */
  icon: string;
  messages: PreviewMessage[];
}

export type ChannelScene =
  | (SceneAgent & { surface: "slack"; channel: string })
  | (SceneAgent & {
      surface: "github";
      thread: { kind: "issue" | "pull"; number: number; title: string };
    })
  | (SceneAgent & { surface: "imessage" });

export interface ChannelPreview {
  /** What the scene shows, for screen readers. */
  alt: string;
  scene: ChannelScene;
}

/** A customer-facing agent (AaaS) on iMessage, shared by the Photon and Linq pages. */
const acmeSupport: ChannelPreview = {
  alt: "An iMessage conversation where a customer asks a store's support agent about a late order, and it replies with the delivery status.",
  scene: {
    surface: "imessage",
    agent: "Acme Support",
    icon: "/channel-previews/acme-support.svg",
    messages: [
      { from: "user", text: "Where's my order? It was supposed to come today" },
      {
        from: "agent",
        text: "Order #4821 is out for delivery and should arrive by 6 PM. Want a text when it's dropped off?",
      },
      { from: "user", text: "yes please" },
    ],
  },
};

/** Keyed by docs page slug, such as `channels/slack`. */
export const channelPreviews: Record<string, ChannelPreview> = {
  "channels/slack": {
    alt: "A Slack thread where someone asks a company brain agent for October's order count, and it replies with a table comparing September and October.",
    scene: {
      surface: "slack",
      agent: "brain",
      icon: "/channel-previews/company-brain.svg",
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
      agent: "foreman",
      icon: "/channel-previews/foreman.png",
      thread: { kind: "issue", number: 471, title: "Checkout returns 500 on empty carts" },
      messages: [
        { from: "user", text: "@foreman can you take this one?" },
        {
          from: "agent",
          text: "On it. Opened draft PR #483 with a guard in `pricing.ts` and a regression test.",
        },
      ],
    },
  },
  "channels/photon": acmeSupport,
  "channels/linq": acmeSupport,
};

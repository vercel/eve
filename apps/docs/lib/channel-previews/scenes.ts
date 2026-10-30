// Sample conversations shown above channel docs pages, one use case per
// channel, drawn from the Use Cases page. They are decorative: the docs app
// renders them from here (not from MDX), so the Markdown that agents read and
// the docs packaged with `eve` stay free of them.

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
    alt: "An iMessage conversation where someone asks an assistant agent for two movie tickets tonight, and it finds seats and asks to book them.",
    scene: {
      surface: "imessage",
      agent: "Concierge",
      messages: [
        { from: "user", text: "Can you grab 2 tickets for Dune tonight, around 7?" },
        { from: "agent", text: "Found a 7:15 showing, 2 seats in row G for $38. Book them?" },
        { from: "user", text: "yes please" },
      ],
    },
  },
  "channels/linq": {
    alt: "An iMessage conversation where someone asks an assistant agent to book their usual dinner, and it remembers the restaurant and offers to confirm.",
    scene: {
      surface: "imessage",
      agent: "Concierge",
      messages: [
        { from: "user", text: "Book the usual for Friday?" },
        { from: "agent", text: "Lupa, table for 2 at 7:30, like last time. Want me to confirm?" },
        { from: "user", text: "perfect" },
      ],
    },
  },
};

import { channelEntries } from "#compiled/@eve/catalog/index.js";
import type { ChannelKind } from "./update/channels.js";

interface ChannelScaffold {
  slug: string;
  kind: ChannelKind;
  registryItem: `channel/${ChannelKind}`;
  label: string;
  hint?: string;
}

const CHANNEL_SCAFFOLDS: readonly ChannelScaffold[] = [
  {
    slug: "eve",
    kind: "web",
    registryItem: "channel/web",
    label: "Web Chat",
    hint: "Next.js app",
  },
  {
    slug: "slack",
    kind: "slack",
    registryItem: "channel/slack",
    label: "Slack",
    hint: "Slack app mentions and DMs",
  },
];

export interface ScaffoldableChannel {
  slug: string;
  kind: ChannelKind;
  registryItem: `channel/${ChannelKind}`;
  label: string;
  hint?: string;
}

function buildScaffoldableChannels(): ScaffoldableChannel[] {
  const scaffoldableSlugs = new Set(
    channelEntries()
      .filter((entry) => entry.surfaces.scaffoldable)
      .map((entry) => entry.slug),
  );

  const channels: ScaffoldableChannel[] = [];
  for (const scaffold of CHANNEL_SCAFFOLDS) {
    if (!scaffoldableSlugs.delete(scaffold.slug)) {
      throw new Error(
        `Channel overlay "${scaffold.slug}" is not a scaffoldable channel in @eve/catalog.`,
      );
    }
    const channel: ScaffoldableChannel = {
      slug: scaffold.slug,
      kind: scaffold.kind,
      registryItem: scaffold.registryItem,
      label: scaffold.label,
    };
    if (scaffold.hint !== undefined) {
      channel.hint = scaffold.hint;
    }
    channels.push(channel);
  }

  if (scaffoldableSlugs.size > 0) {
    const missing = [...scaffoldableSlugs].sort().join(", ");
    throw new Error(`Scaffoldable catalog channels missing a scaffolder overlay: ${missing}.`);
  }

  return channels;
}

export const SCAFFOLDABLE_CHANNELS: readonly ScaffoldableChannel[] = buildScaffoldableChannels();

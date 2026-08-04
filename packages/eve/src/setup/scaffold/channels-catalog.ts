/**
 * Build-time catalog of channels used by programmatic setup and
 * `eve add channel/slack`.
 *
 * Channel *identity* (slug, name, and whether it is scaffoldable) is owned by
 * `@eve/catalog`, the cross-surface source of truth shared with the docs
 * gallery. This module overlays the scaffolder-only concerns — the internal
 * {@link ChannelKind} (the catalog's `eve` web-chat channel is surfaced to users
 * as `web`), the picker copy, and the picker order — and validates that the
 * overlay and the catalog cannot drift apart.
 */

import { channelEntries } from "@eve/catalog";
import type { ChannelKind } from "./update/channels.js";

/** Scaffolder overlay for one catalog channel the CLI can scaffold. */
interface ChannelScaffold {
  /** Catalog slug this overlay scaffolds. Must be a `scaffoldable` channel. */
  slug: string;
  /** Internal scaffolder kind; the catalog's `eve` channel is surfaced as `web`. */
  kind: ChannelKind;
  /** Canonical item in the official eve registry. */
  registryItem: `channel/${ChannelKind}`;
  /** Picker label. */
  label: string;
  /** Optional picker hint. */
  hint?: string;
}

/**
 * Scaffolder overlays in picker display order. Picker order is a CLI concern, so
 * it lives here rather than in the catalog — the docs gallery orders channels
 * differently from this picker. Membership is validated against the catalog by
 * {@link buildScaffoldableChannels}, so the catalog stays the source of truth
 * for *which* channels are scaffoldable.
 */
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

/** A catalog channel the CLI can scaffold, paired with its picker presentation. */
export interface ScaffoldableChannel {
  /** Catalog slug. */
  slug: string;
  /** Internal scaffolder kind passed to `ensureChannel`. */
  kind: ChannelKind;
  /** Canonical item in the official eve registry. */
  registryItem: `channel/${ChannelKind}`;
  /** Picker label. */
  label: string;
  /** Optional picker hint. */
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

/**
 * Channels the CLI can scaffold, in picker order. Derived from
 * `@eve/catalog` (`surfaces.scaffoldable`) overlaid with
 * {@link CHANNEL_SCAFFOLDS}. Throws at module load if the two disagree.
 */
export const SCAFFOLDABLE_CHANNELS: readonly ScaffoldableChannel[] = buildScaffoldableChannels();

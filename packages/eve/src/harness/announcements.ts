import { createHash } from "node:crypto";
import type { ModelMessage } from "ai";

import type { HistoryState } from "#context/keys.js";
import type { UserMessageKind } from "#harness/messages.js";

export interface Announcement {
  readonly value: string;
  render(previous: string | undefined): string | undefined;
  readonly initial?: string;
  readonly kind?: Extract<UserMessageKind, "context.instruction" | "context.state">;
}

export function announcementDigest(kind: unknown, content: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify([kind, content]))
    .digest("base64url")
    .slice(0, 22);
}

export function keptAnnouncements(
  state: HistoryState,
  history: readonly ModelMessage[],
): HistoryState {
  const held = new Set(
    history.flatMap((message) =>
      message.role === "user"
        ? [announcementDigest((message as { readonly kind?: unknown }).kind, message.content)]
        : [],
    ),
  );
  const kept = Object.entries(state.messages ?? {}).filter(([, digest]) => held.has(digest));
  if (kept.length === 0) return {};
  return {
    announcements: Object.fromEntries(
      kept.flatMap(([key]) => {
        const value = state.announcements?.[key];
        return value === undefined ? [] : [[key, value]];
      }),
    ),
    messages: Object.fromEntries(kept),
  };
}

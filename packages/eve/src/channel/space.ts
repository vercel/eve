import {
  normalizeConversationSpace,
  type ConversationSpace,
  type ConversationSpaceContext,
} from "#shared/conversation-context.js";
import { isThenable } from "#shared/guards.js";

export type ChannelSpaceProjector = (
  input: ConversationSpaceContext<Record<string, unknown> | undefined>,
) => ConversationSpace | undefined;

type ChannelSpaceSource = {
  readonly state?: Record<string, unknown> | undefined;
  readonly instrumentation?: { readonly space?: ChannelSpaceProjector };
};

export function resolveSpace(adapter: ChannelSpaceSource): ConversationSpace | undefined {
  const project = adapter.instrumentation?.space;
  if (project === undefined) return undefined;
  try {
    const value: unknown = project({ state: adapter.state });
    if (isThenable(value)) {
      console.warn("ignoring channel space projection because it returned a Promise");
      void Promise.resolve(value).catch(() => undefined);
      return undefined;
    }
    return normalizeConversationSpace(value);
  } catch {
    console.warn("ignoring channel space projection after failure");
    return undefined;
  }
}

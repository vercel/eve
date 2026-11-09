import { ConversationContextKey, type ConversationSpace } from "#shared/conversation-context.js";
import { type Definition, section, SECTION_ORDER } from "./definition.js";

const KIND: Record<ConversationSpace["type"], string> = {
  channel: "a channel that people join",
  direct: "a direct conversation with one person",
  group: "a group conversation among a fixed set of people",
};

/** The model's note on where the conversation happens, from the channel's reported space. */
export function conversationSpaceNote(space: ConversationSpace): string {
  return [
    "<conversation_space>",
    `type: ${space.type}`,
    `visibility: ${space.visibility ?? "unknown"}`,
    "</conversation_space>",
    `This conversation is ${KIND[space.type]}.${
      space.visibility === "public"
        ? " Anyone in its workspace can find and read it."
        : space.visibility === "private"
          ? " Only its members can see it."
          : " Whether people outside it can see it is unknown."
    }`,
  ].join("\n");
}

/**
 * Tells the model where the conversation happens: the type and visibility of
 * the space its channel reported, never its ID. A part of its own after the
 * shared prompt, so sessions in different places keep that prompt cached.
 */
export const conversation: Definition = {
  contribute: ({ container }) => ({
    system: () => {
      const space = container.get(ConversationContextKey)?.space;
      return space === undefined
        ? []
        : [
            section("eve.conversation", conversationSpaceNote(space), {
              order: SECTION_ORDER.conversation,
              part: "own",
            }),
          ];
    },
  }),
  id: "eve.conversation",
  label: "where the conversation happens",
};

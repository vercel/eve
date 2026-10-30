import { defineDynamic, defineInstructions } from "eve/instructions";
import { BASE_INSTRUCTIONS } from "./lib/base-instructions.js";
import { buildUserContextPrompt, fetchUserContext } from "./lib/memory-internal.js";

const IMESSAGE_INSTRUCTIONS = `

# iMessage (Sendblue)

- This conversation is over iMessage. There is no browser UI for tool approvals in this thread.
- Answer the user's question directly. Use Linear, weather, and other tools when relevant.
- Do **not** call \`save_memory\` unless the user explicitly asks you to remember or save something.
- If they want to update long-term memory, tell them to edit **Settings → Profile** on the web app.`;

function instructionsForChannel(kind: string | undefined, base: string) {
  if (kind === "channel:sendblue") {
    return `${base}${IMESSAGE_INSTRUCTIONS}`;
  }
  return base;
}

export default defineDynamic(async (ctx) => {
  const userId = ctx.session.auth.current?.principalId;
  // The user's profile is read once per user for the session.
  const userBlock =
    !userId || userId.startsWith("eve:")
      ? null
      : await ctx.memo(userId, async () => {
          const context = await fetchUserContext(userId);
          return context ? buildUserContextPrompt(context) : null;
        });
  return defineInstructions({
    content: instructionsForChannel(
      ctx.channel.kind,
      userBlock === null ? BASE_INSTRUCTIONS : `${BASE_INSTRUCTIONS}\n\n---\n\n${userBlock}`,
    ),
  });
});

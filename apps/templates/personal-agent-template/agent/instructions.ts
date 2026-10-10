import { defineDynamic, defineInstructions } from "eve/instructions";
import type { ResolveContext } from "eve/instructions";
import { BASE_INSTRUCTIONS } from "./lib/base-instructions.js";
import { buildUserContextPrompt, fetchUserContext } from "./lib/memory-internal.js";

const IMESSAGE_INSTRUCTIONS = `

# iMessage (Sendblue)

- This conversation is over iMessage. There is no browser UI for tool approvals in this thread.
- Answer the user's question directly. Use Linear, weather, and other tools when relevant.
- Do **not** call \`save_memory\` unless the user explicitly asks you to remember or save something.
- If they want to update long-term memory, tell them to edit **Settings → Profile** on the web app.`;

function instructionsForChannel(kind: string | undefined, base: string) {
  if (kind === "sendblue") {
    return `${base}${IMESSAGE_INSTRUCTIONS}`;
  }
  return base;
}

export default defineDynamic({
  select: () => null,
  resolve: async (_event, ctx: ResolveContext) => {
    const userId = ctx.session.auth.current?.principalId;
    if (!userId || userId.startsWith("eve:")) {
      return defineInstructions({
        markdown: instructionsForChannel(ctx.channel.kind, BASE_INSTRUCTIONS),
      });
    }

    const context = await fetchUserContext(userId);
    if (!context) {
      return defineInstructions({
        markdown: instructionsForChannel(ctx.channel.kind, BASE_INSTRUCTIONS),
      });
    }

    const userBlock = buildUserContextPrompt(context);
    return defineInstructions({
      markdown: instructionsForChannel(
        ctx.channel.kind,
        `${BASE_INSTRUCTIONS}\n\n---\n\n${userBlock}`,
      ),
    });
  },
});

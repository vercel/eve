import { defineDynamic, defineTool } from "eve/tools";

const MARKER = "[lucky]";

/**
 * A dynamic tool that changes between evaluations while the latest request is marked `[lucky]`:
 * its description draws a random number outside a memo. A fresh process would build it
 * differently, so in development eve evaluates it twice and warns.
 */
export default defineDynamic(async (ctx) => {
  const latest = [...(await ctx.messages())].reverse().find((message) => message.role === "user");
  const lucky = JSON.stringify(latest?.content ?? "").includes(MARKER);
  return lucky
    ? defineTool({
        description: `Draws lucky number ${Math.random()}.`,
        inputSchema: {},
        execute: async () => ({ drawn: true }),
      })
    : null;
});

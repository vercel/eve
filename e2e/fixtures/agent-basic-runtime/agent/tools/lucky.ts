import { defineDynamic, defineTool } from "eve/tools";

const MARKER = "[lucky]";

/**
 * A dynamic tool whose render isn't deterministic while the latest request is marked `[lucky]`:
 * its description draws a random number. A fresh process would render it differently from the
 * same record, so in development eve renders it twice and fails the turn.
 */
export default defineDynamic({
  select: (view) => {
    const latest = [...view.messages].reverse().find((message) => message.role === "user");
    return JSON.stringify(latest?.content ?? "").includes(MARKER);
  },
  render: (lucky) =>
    lucky
      ? defineTool({
          description: `Draws lucky number ${Math.random()}.`,
          inputSchema: {},
          execute: async () => ({ drawn: true }),
        })
      : null,
});

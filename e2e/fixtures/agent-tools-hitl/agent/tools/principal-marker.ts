import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Reports current and initiating principals. Call only when explicitly requested.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const { current, initiator } = ctx.session.auth;
    return {
      marker: `PRINCIPALS current=${format(current)} initiator=${format(initiator)}`,
    };
  },
});

function format(value: { readonly principalId: string; readonly principalType: string } | null) {
  return value === null ? "none" : `${value.principalType}:${value.principalId}`;
}

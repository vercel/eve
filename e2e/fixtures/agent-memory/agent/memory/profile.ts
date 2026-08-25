import { defineMemory } from "eve/memory";
import { byPrincipal } from "eve/memory/scope";
import { defineTool } from "eve/tools";
import { z } from "zod";

const profiles = new Map<string, string>();

export default defineMemory({
  description: "Update the durable profile value for this caller.",
  provider: {
    async recall(ctx) {
      const value = profiles.get(ctx.memory.scope.key) ?? "OLD_PROFILE_VALUE";
      return { messages: [{ content: `PROFILE_VALUE=${value}`, id: "profile" }] };
    },
    async tools(ctx) {
      return {
        save: defineTool({
          description: "Save the caller's profile value.",
          inputSchema: z.object({ value: z.string() }),
          async execute({ value }) {
            profiles.set(ctx.memory.scope.key, value);
            return { saved: true };
          },
        }),
      };
    },
  },
  scope: byPrincipal,
});

import { defineDynamic, defineTool } from "eve/tools";

export default defineDynamic({
  events: {
    beforeModel: (_event, ctx) => {
      if (!JSON.stringify(ctx.messages).includes("[expand-envelope]")) return null;
      return {
        catalog_probe: defineTool({
          description: "Inspect the expanded catalog.",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: "Catalog query documentation. ".repeat(650) },
            },
            required: ["query"],
            additionalProperties: false,
          },
          execute: () => "catalog-ready",
        }),
      };
    },
  },
});

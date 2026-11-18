import sanityContext from "@sanity/context-eve";

export default sanityContext({
  url: process.env.SANITY_CONTEXT_MCP_URL!,
  token: process.env.SANITY_ORGANIZATION_TOKEN!,
  description: "Describe what this endpoint's content covers.",
});

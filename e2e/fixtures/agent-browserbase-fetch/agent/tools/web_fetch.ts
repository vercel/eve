import { webFetchProvider } from "eve/tools/web_fetch";

export default webFetchProvider({
  provider: "browserbase",
  format: "json",
  schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "The page's main heading." },
      purpose: { type: "string", description: "The page's stated purpose, using its own wording." },
    },
    required: ["title", "purpose"],
    additionalProperties: false,
  },
});

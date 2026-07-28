import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp.notion.com/mcp",
  description: "Notion workspace: search and edit pages and databases.",
  auth: connect("notion"),

  // For app-scoped authentication, replace the auth block above with:
  // auth: connect({ connector: "notion", principalType: "app" }),

  // For JWT bearer authentication, replace the auth block above with:
  // auth: connect({
  //   connector: "notion",
  //   principalToSubject: (principal) => {
  //     const email = principal.type === "user" ? principal.attributes?.email : undefined;
  //     if (typeof email !== "string") {
  //       throw new Error("JWT bearer authentication requires a user principal with an email.");
  //     }
  //     return { type: "jwt-bearer", sub: email };
  //   },
  // }),

  // Notion also supports OpenAPI. See https://eve.dev/integrations/notion for that scaffold.
});

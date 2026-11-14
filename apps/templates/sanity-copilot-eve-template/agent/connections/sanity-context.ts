import { defineDynamic, defineMcpClientConnection } from "eve/connections";

/**
 * Optional, read-only connection to a Sanity Context MCP endpoint.
 *
 * @remarks
 * Sanity Context serves a scoped, read-only view of content to agents: Knowledge Bases built
 * from datasets, websites, and files, and optionally a dataset queried with GROQ. It complements
 * the `sanity` connection, which acts on the project as the signed-in user and is the only one
 * that can write.
 *
 * The connection exists only when both `SANITY_CONTEXT_MCP_URL` (the endpoint URL from the
 * Context app in the Sanity Dashboard) and `SANITY_ORGANIZATION_TOKEN` (an organization API
 * token with the Context Viewer role; project tokens are refused) are set. With either one
 * missing the function returns `null` and the agent has no such connection, so a default
 * deployment is unaffected. eve runs this function before each model call, so it reads the
 * environment only.
 *
 * Unlike the other connections, this one authenticates with a static token shared by every
 * user, so everyone reads the same content whatever their own Sanity permissions. The endpoint
 * is read-only, so no tool is gated on approval. `instanceKey` is required on a dynamic
 * connection with auth; change it if you point the connection at a different endpoint.
 *
 * @see {@link https://www.sanity.io/docs/context/connect-vercel-eve | Connect Sanity Context with Vercel eve}
 */
export default defineDynamic(() => {
  const url = process.env.SANITY_CONTEXT_MCP_URL;
  const token = process.env.SANITY_ORGANIZATION_TOKEN;
  if (!(url && token)) {
    return null;
  }
  return defineMcpClientConnection({
    auth: { getToken: () => Promise.resolve({ token }) },
    description:
      "Sanity Context: read-only reference knowledge, such as Knowledge Bases built from " +
      "documents, websites, and files. Look things up here when a task needs reference " +
      "material the Sanity project and Notion don't hold. It cannot create or change content.",
    instanceKey: "sanity-context",
    url,
  });
});

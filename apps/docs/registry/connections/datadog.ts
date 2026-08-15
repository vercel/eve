import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp.datadoghq.com/api/mcp",
  description: "Datadog: query metrics, monitors, logs, and incidents.",
  auth: connect({
    connector: "datadog",
    principalToSubject: (principal) => {
      const email = principal.type === "user" ? principal.attributes?.email : undefined;
      if (typeof email !== "string") {
        throw new Error("JWT bearer authentication requires a user principal with an email.");
      }
      return { type: "jwt-bearer", sub: email };
    },
  }),
});

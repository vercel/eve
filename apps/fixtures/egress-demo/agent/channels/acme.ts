import { defineChannel, GET } from "eve/channels";

import { ACME_API_TOKEN } from "../lib/acme-oauth.js";

/**
 * The fake protected API. Served by this app so the demo is fully
 * self-contained: the sandbox curls this route through the Vercel
 * firewall, and only the firewall-injected bearer unlocks it.
 */
export default defineChannel({
  routes: [
    GET("/acme/report", async (request) => {
      const authorized = request.headers.get("authorization") === `Bearer ${ACME_API_TOKEN}`;
      if (!authorized) {
        return Response.json({ error: "Missing or invalid Acme credentials." }, { status: 401 });
      }
      return Response.json({
        quarter: "Q3",
        revenue: "$12.4M",
        note: "Only firewall-authorized egress can read this.",
      });
    }),
  ],
});

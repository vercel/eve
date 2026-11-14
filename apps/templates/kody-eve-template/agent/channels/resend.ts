import { defineChannel, POST } from "eve/channels";

/**
 * Rejects all inbound email, including replies to previously subscribed threads.
 *
 * @remarks
 * Resend webhook signatures authenticate delivery, not authority to use the
 * installation's tools. Re-enabling commands requires a separately authenticated
 * authorization protocol; From addresses and thread headers are not sufficient.
 * Outbound digests use the Resend MCP connection, not this route.
 */
export default defineChannel({
  routes: [
    POST("/eve/v1/resend", async () =>
      Response.json(
        { error: "Inbound email commands are disabled." },
        { status: 403 }
      )
    ),
  ],
});

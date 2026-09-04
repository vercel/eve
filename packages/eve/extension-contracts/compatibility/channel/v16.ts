import { defineChannel, GET, WS } from "#public/channels/index.js";

export default defineChannel({
  routes: [
    GET("/legacy/:id", async (_request, { params }) => Response.json({ id: params.id })),
    WS("/legacy/socket", () => ({
      upgrade() {
        return { context: { authorized: true }, headers: { "x-channel": "legacy" } };
      },
      open(peer) {
        peer.subscribe("events");
      },
      message(peer, message) {
        peer.send(message.text());
      },
      close(peer) {
        peer.unsubscribe("events");
      },
    })),
  ],
});

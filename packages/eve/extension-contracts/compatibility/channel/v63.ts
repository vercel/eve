import { defineChannel, type ChannelDelivery } from "#public/channels/index.js";

export default defineChannel({
  state: { author: "" },
  deliver(payload: ChannelDelivery<{ author: string }>) {
    return { ...payload, context: [payload.state?.author ?? "Anonymous"] };
  },
  routes: [],
  events: {
    "call.started"(event) {
      const clearance = event.data.clearedBy;
      if (clearance !== undefined && "policy" in clearance) console.info(clearance.policy);
    },
  },
});

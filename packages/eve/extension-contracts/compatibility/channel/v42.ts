import { defineChannel } from "#public/channels/index.js";

export default defineChannel({
  routes: [],
  events: {
    "task.settled"(event) {
      console.info("task settled", {
        name: event.name,
        status: event.status,
        cancel: event.cancel,
      });
    },
  },
});

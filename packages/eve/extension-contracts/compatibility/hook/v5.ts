import { defineHook } from "#public/hooks/index.js";

export default defineHook({
  events: {
    "input.requested"(event) {
      console.info(
        "input requested",
        event.data.requests.map((request) => request.requestId),
      );
    },
  },
});

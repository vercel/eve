import { defineChannel } from "#public/channels/index.js";

// Existing extensions consume runtime-owned handles without calling prewarm.
// Adding preparation does not change their dispatch or returned session behavior.
export default defineChannel({
  routes: [],
  receive(input, { from }) {
    return from("chat").send(input.message, { auth: input.auth });
  },
});

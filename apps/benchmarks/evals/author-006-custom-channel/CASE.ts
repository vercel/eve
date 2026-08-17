import { defineAuthoringCase, simpleProject } from "../../lib/authoring-case.js";

export default defineAuthoringCase({
  startingPoint: simpleProject,
  async interact({ send }) {
    await send(
      "Add a custom channel named `support` for an internal support system. It needs a POST route at `/support/:threadId/messages` that reads a JSON `message`, uses the thread ID as the channel continuation address, sends the message with no user auth, and returns the durable session ID as JSON. Queue overlapping messages so an active turn finishes before the next one starts.",
    );
  },
});

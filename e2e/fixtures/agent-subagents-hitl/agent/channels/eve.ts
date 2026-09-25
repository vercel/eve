import { eveChannel } from "eve/channels/eve";
import { localDev, placeholderAuth, vercelOidc } from "eve/channels/auth";
import { inputHookAudit } from "../../input-hook-audit";

export default eveChannel({
  auth: [vercelOidc(), localDev(), placeholderAuth()],
  events: {
    "input.requested"(event, _channel, ctx) {
      inputHookAudit.update((observations) => [
        ...observations,
        {
          receiver: "channel",
          sessionId: ctx.session.id,
          requestIds: event.requests.map((request) => request.requestId),
        },
      ]);
    },
  },
});

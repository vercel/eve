import type { Channel } from "eve/channels";
import { localDev } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";
import {
  appendInvestigationEvidenceToAnswer,
  getInvestigationEvidence,
} from "#lib/evidence.ts";

const channel: Channel = eveChannel({
  auth: [localDev()],
  /**
   * The event here exists solely to ensure that evidence gets appended to local development turns,
   * just like on the Slack channel.
   */
  events: {
    "message.completed"(data) {
      if (data.finishReason === "tool-calls" || !data.message) {
        return;
      }

      data.message = appendInvestigationEvidenceToAnswer(
        data.message,
        getInvestigationEvidence(data.turnId)
      );
    },
  },
});

export default channel;

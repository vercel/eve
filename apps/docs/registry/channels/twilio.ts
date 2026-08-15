import { twilioChannel } from "eve/channels/twilio";

export default twilioChannel({
  allowFrom: "+15551234567",
  messaging: { from: "+15557654321" },
});

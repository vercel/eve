import { sendblueChannel } from "eve/channels/sendblue";

export default sendblueChannel({
  allowedServices: ["iMessage", "SMS", "RCS"],
});

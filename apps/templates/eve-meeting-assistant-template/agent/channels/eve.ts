import { localDev, vercelOidc } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

// Lets `eve remote connect` reach the deployment with this project's Vercel
// OIDC token, from `vercel env pull`, so you can send eve to a meeting.
export default eveChannel({
  auth: [vercelOidc(), localDev()],
});

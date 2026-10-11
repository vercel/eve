import { localDev, vercelOidc } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

export default eveChannel({
  // This isolated fixture has no production tools or data.
  auth: [vercelOidc(), localDev()].map((authenticate) => async (request) => {
    const auth = await authenticate(request);
    return auth ? { ...auth, allowToolStubs: true } : null;
  }),
});

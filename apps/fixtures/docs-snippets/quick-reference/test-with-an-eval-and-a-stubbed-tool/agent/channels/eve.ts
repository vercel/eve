import { localDev } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

const dev = localDev();

export default eveChannel({
  // Local `eve dev` only: lets `eve eval` replace tools with stubs.
  auth: async (request) => {
    const caller = await dev(request);
    return caller ? { ...caller, allowToolStubs: true } : null;
  },
});

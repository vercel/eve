import { defineToolStubs } from "eve/evals";

import { CORRECTED_MEASUREMENT, NOTEBOOK_CORRECTION } from "../../constants";

/** Answers the remote keeper's messages, so no request reaches the remote agent. */
export default defineToolStubs({
  tools: {
    "remote-loopback": ({ message }: { message: string }) =>
      message.includes(NOTEBOOK_CORRECTION)
        ? `STUB ${CORRECTED_MEASUREMENT}`
        : "STUB NOTEBOOK-DEPTH north pier 3.1 m",
  },
});

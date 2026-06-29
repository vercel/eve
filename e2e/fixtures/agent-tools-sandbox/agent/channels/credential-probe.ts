import { defineChannel, GET } from "eve/channels";

import { CREDENTIAL_PROBE_PATH, CREDENTIAL_PROBE_TOKEN } from "../credential-probe.js";

export default defineChannel({
  routes: [
    GET(CREDENTIAL_PROBE_PATH, async (request) => {
      const authorized =
        request.headers.get("authorization") === `Bearer ${CREDENTIAL_PROBE_TOKEN}`;
      return Response.json({ authorized }, { status: authorized ? 200 : 401 });
    }),
  ],
});

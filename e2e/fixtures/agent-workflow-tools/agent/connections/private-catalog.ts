import { defineDynamic, defineMcpClientConnection } from "eve/connections";

import { createFakeAuthProvider } from "../lib/fake-auth-provider.ts";
import { fixtureUrl } from "../lib/fake-service.ts";

export default defineDynamic({
  events: {
    "session.started": () =>
      defineMcpClientConnection({
        description: "Private catalog that requires sign-in before discovering its tools.",
        url: fixtureUrl("/fixture-catalog/mcp").href,
        instanceKey: "fixture-private-catalog",
        auth: createFakeAuthProvider({ expiredToken: false }),
      }),
  },
});

import { defineDynamic, defineMcpClientConnection, once } from "eve/connections";

import { createFakeAuthProvider } from "../lib/fake-auth-provider.ts";
import { fixtureUrl } from "../lib/fake-service.ts";

export default defineDynamic({
  select: once,
  render: () =>
    defineMcpClientConnection({
      description: "Private catalog that requires sign-in before discovering its tools.",
      url: fixtureUrl("/fixture-catalog/mcp").href,
      instanceKey: "fixture-private-catalog",
      auth: createFakeAuthProvider({ expiredToken: false, rememberSignIns: true }),
    }),
});

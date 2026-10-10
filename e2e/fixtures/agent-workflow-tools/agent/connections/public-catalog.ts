import { defineDynamic, defineMcpClientConnection } from "eve/connections";

import { createFakeAuthProvider } from "../lib/fake-auth-provider.ts";
import { fixtureUrl } from "../lib/fake-service.ts";

export default defineDynamic({
  resolve: () =>
    defineMcpClientConnection({
      description: "Public catalog: lists items without sign-in; orders need sign-in.",
      url: fixtureUrl("/fixture-public-catalog/mcp").href,
      instanceKey: "fixture-public-catalog",
      auth: createFakeAuthProvider({ expiredToken: false, rememberSignIns: true }),
    }),
});

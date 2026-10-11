import { defineDynamic, defineOpenAPIConnection } from "eve/connections";

import { petstoreBaseUrl, petstoreHeaders, petstoreSpecUrl } from "../../petstore";

// Resolved per session because the fixture's own URL is known only at runtime.
export default defineDynamic({
  events: {
    "session.started": () => ({
      petstore: defineOpenAPIConnection({
        baseUrl: petstoreBaseUrl(),
        spec: petstoreSpecUrl(),
        headers: petstoreHeaders(),
        description: "Pet store inventory API.",
      }),
    }),
  },
});

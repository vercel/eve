import { defineDynamic, defineMcpClientConnection } from "eve/connections";

import { kennelHeaders, kennelUrl } from "../../kennel";

export default defineDynamic({
  events: {
    "session.started": () =>
      defineMcpClientConnection({
        description: "Maple Street kennel: boarding pets, feedings, photos, and care visits.",
        url: kennelUrl(),
        headers: kennelHeaders(),
      }),
  },
});

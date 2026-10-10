import { defineDynamic, defineMcpClientConnection } from "eve/connections";

import { kennelHeaders, kennelUrl } from "../../kennel";

export default defineDynamic({
  select: () => null,
  resolve: () =>
    defineMcpClientConnection({
      description: "Maple Street kennel: boarding pets, feedings, photos, and care visits.",
      url: kennelUrl(),
      headers: kennelHeaders(),
    }),
});

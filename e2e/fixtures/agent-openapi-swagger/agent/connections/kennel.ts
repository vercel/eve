import { defineDynamic, defineMcpClientConnection, once } from "eve/connections";

import { kennelHeaders, kennelUrl } from "../../kennel";

export default defineDynamic({
  select: once,
  render: () =>
    defineMcpClientConnection({
      description: "Maple Street kennel: boarding pets, feedings, photos, and care visits.",
      url: kennelUrl(),
      headers: kennelHeaders(),
    }),
});
